import imaplib, sys
email, pw = "julokojehiwefape@dewaa.id", "Koyori@3351"
try:
    m = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    m.login(email, pw)
    print("LOGIN OK")
    m.select("INBOX")
    typ, data = m.search(None, 'FROM', 'github')
    ids = data[0].split()
    print("github emails:", len(ids))
    if ids:
        typ, msg = m.fetch(ids[-1], "(BODY[TEXT])")
        body = msg[0][1].decode("utf-8", "replace") if msg and msg[0] else ""
        print("LATEST BODY (first 500):", body[:500])
    m.logout()
except Exception as e:
    print("IMAP FAIL:", e)
