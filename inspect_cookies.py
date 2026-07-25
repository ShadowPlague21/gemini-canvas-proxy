import sqlite3

try:
    conn = sqlite3.connect('/browser-data/chromium-profile/Default/Cookies')
    c = conn.cursor()
    rows = c.execute('SELECT host_key, name, length(encrypted_value), is_secure FROM cookies').fetchall()
    print(f"Total cookies in DB: {len(rows)}")
    for r in rows:
        if 'SID' in r[1] or 'LOGIN' in r[1] or 'OSID' in r[1]:
            print(r)
except Exception as e:
    print("Error:", e)
