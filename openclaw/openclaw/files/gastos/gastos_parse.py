"""Parser determinístico de correos BCI: compras con débito y transferencias."""
import email
import html
import re
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime


# Avisos del banco que no son movimientos de dinero.
IGNORAR = ("acceso a información", "activación", "código de verificación", "pinpass", "clave")


def _hdr(m, name):
    return str(make_header(decode_header(m[name] or "")))


def _html_lines(m):
    for p in m.walk():
        if p.get_content_type() == "text/html":
            b = p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8", "replace")
            b = re.sub(r"<(style|script)[^>]*>.*?</\1>", "", b, flags=re.S | re.I)
            b = re.sub(r"<br\s*/?>|</(p|div|td|tr|li|h\d)>", "\n", b, flags=re.I)
            t = html.unescape(re.sub(r"<[^>]+>", " ", b))
            return [re.sub(r"\s+", " ", l).strip() for l in t.splitlines() if l.strip()]
    return []


def email_text(raw):
    """Texto plano del correo (lo que vería un LLM)."""
    m = email.message_from_string(raw) if isinstance(raw, str) else email.message_from_bytes(raw)
    return "\n".join(_html_lines(m))


def _after(lines, label):
    """Valor que sigue a una etiqueta: en la misma línea o en la siguiente."""
    for i, l in enumerate(lines):
        if l.lower().startswith(label.lower()):
            rest = l[len(label):].strip(" :")
            if rest:
                return rest
            return lines[i + 1] if i + 1 < len(lines) else None
    return None


def _monto(s):
    if not s:
        return None
    m = re.search(r"(US\$|USD|\$)\s*([\d.]+(?:,\d+)?)", s)
    if not m:
        return None
    moneda = "USD" if "US" in m.group(1) else "CLP"
    v = m.group(2).replace(".", "").replace(",", ".")
    return (float(v) if "." in v else int(v)), moneda


def parse(raw):
    """Devuelve un dict con los campos o {'tipo': 'desconocido', ...} si no reconoce el formato."""
    m = email.message_from_string(raw) if isinstance(raw, str) else email.message_from_bytes(raw)
    frm = email.utils.parseaddr(m["From"] or "")[1].lower()
    subj = _hdr(m, "Subject")
    date = parsedate_to_datetime(m["Date"]) if m["Date"] else None
    lines = _html_lines(m)
    base = {"from": frm, "subject": subj, "email_date": date.isoformat() if date else None}

    if any(s in subj.lower() for s in IGNORAR):
        return {**base, "tipo": "ignorar"}

    if frm == "contacto@bci.cl" and subj.lower().startswith("notificación de uso de tu tarjeta"):
        # La frase viene partida en varias líneas: "Realizaste un(a)" / "compra en comercio nacional" / ...
        i0 = next((i for i, l in enumerate(lines) if l.lower().startswith("realizaste")), None)
        i1 = next((i for i, l in enumerate(lines) if l.lower().startswith("número tarjeta")), None)
        intro = " ".join(lines[i0:i1]) if i0 is not None and i1 else ""
        mm = _monto(_after(lines, "Monto"))
        if not mm:
            return {**base, "tipo": "desconocido", "motivo": "compra sin monto"}
        k = re.search(r"realizaste un\(a\) (.+?) con tu", intro, re.I)
        return {**base, "tipo": "compra",
                "operacion": k.group(1).strip() if k else intro,
                "internacional": "internacional" in intro.lower(),
                "tarjeta": re.sub(r"\D", "", _after(lines, "Número tarjeta débito") or _after(lines, "Número tarjeta") or "")[-4:],
                "monto": mm[0], "moneda": mm[1],
                "fecha": _after(lines, "Fecha"),
                "hora": (_after(lines, "Hora") or "").replace(" horas", ""),
                "contraparte": _after(lines, "Comercio")}

    es_tef = subj.lower().startswith("aviso de transferencia de fondos")
    if es_tef and any(l.lower().startswith("has recibido") for l in lines):
        # Copia que BCI manda al destinatario (p.ej. a tu propia cuenta en otro banco):
        # mismo comprobante que el aviso de salida, no se registra dos veces.
        return {**base, "tipo": "copia_destinatario", "comprobante": _after(lines, "Número de comprobante"),
                "monto": (_monto(_after(lines, "Monto recibido")) or (None,))[0]}

    if frm in ("transferencias@bci.cl", "contacto@bci.cl") and es_tef:
        mm = _monto(_after(lines, "Monto transferido"))
        if not mm:
            return {**base, "tipo": "desconocido", "motivo": "transferencia sin monto"}
        cuenta = re.sub(r"\D", "", _after(lines, "Cuenta de destino") or "")
        return {**base, "tipo": "transferencia",
                "monto": mm[0], "moneda": mm[1],
                "contraparte": _after(lines, "Nombre del destinatario"),
                "programada": "programada" in subj.lower(),
                "banco": _after(lines, "Banco de destino") or _after(lines, "de destino"),
                "cuenta4": cuenta[-4:],
                "fecha": _after(lines, "Fecha de abono"),
                "hora": date.strftime("%H:%M") if date else None,
                "mensaje": _after(lines, "Mensaje"),
                "comprobante": _after(lines, "Número de comprobante")}

    return {**base, "tipo": "desconocido", "motivo": "remitente/asunto no reconocido"}


# --- cartola cuenta corriente (PDF cifrado) -------------------------------------

_ROW = re.compile(r"^(\d{2}-\d{2}-\d{4}) (UGCA|PROVIDENC|OF CENTRA|OF VIRT U|\S+)\s+(.+?)\s+([\d.]+) (-?[\d.]+)$")


def _n(s):
    return int(s.replace(".", ""))


def cartola_pdf(raw):
    """Bytes del PDF adjunto de un correo de cartola, o None."""
    m = email.message_from_bytes(raw)
    for p in m.walk():
        fn = p.get_filename()
        if fn and fn.lower().endswith(".pdf"):
            return p.get_payload(decode=True)
    return None


def parse_cartola(pdf_bytes, password):
    """Movimientos de la cartola. Cargo/abono se deduce del saldo diario y se valida contra el resumen."""
    import io
    import pypdf
    r = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    if r.is_encrypted and not r.decrypt(password):
        raise ValueError("contraseña de cartola incorrecta")
    txt = "\n".join(p.extract_text() for p in r.pages)
    per = re.search(r"PERIODO\s*:\s*(\d{2}-\d{2}-\d{4}) al (\d{2}-\d{2}-\d{4})", txt)
    prev = _n(re.search(r"Saldo Anterior\s*\n\s*(-?[\d.]+)", txt).group(1))
    tot = re.search(r"Cheques\s*\n\s*([\d.]+) \+\s*\nTotal Abonos y\s*\nDepositos\s*\n\s*([\d.]+)", txt)
    movs, sin_cuadrar = [], 0
    for line in txt.splitlines():
        m = _ROW.match(line.strip())
        if not m:
            continue
        fecha, _suc, desc, monto, saldo = m.groups()
        monto, saldo = _n(monto), _n(saldo)
        if saldo == prev - monto:
            tipo = "cargo"
        elif saldo == prev + monto:
            tipo = "abono"
        else:
            tipo = "?"; sin_cuadrar += 1
        movs.append({"fecha": fecha.replace("-", "/"), "descripcion": " ".join(desc.split()),
                     "tipo": tipo, "monto": monto, "saldo": saldo})
        prev = saldo
    cargos = sum(x["monto"] for x in movs if x["tipo"] == "cargo")
    abonos = sum(x["monto"] for x in movs if x["tipo"] == "abono")
    res_c, res_a = (_n(tot.group(1)), _n(tot.group(2))) if tot else (None, None)
    return {"periodo": per.groups() if per else None, "movimientos": movs,
            "cargos": cargos, "abonos": abonos, "resumen_cargos": res_c, "resumen_abonos": res_a,
            "cuadra": sin_cuadrar == 0 and cargos == res_c and abonos == res_a}
