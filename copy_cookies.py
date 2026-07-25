import sqlite3
import os

cookies_path = '/browser-data/chromium-profile/Default/Cookies'

if not os.path.exists(cookies_path):
    print(f"[copy_cookies] Cookie database not found at {cookies_path}, skipping.")
    exit(0)

try:
    conn = sqlite3.connect(cookies_path)
    c = conn.cursor()
    
    cols = [description[0] for description in c.execute('SELECT * FROM cookies LIMIT 1').description]
    rows = c.execute('SELECT * FROM cookies WHERE host_key LIKE "%.google.co.in" OR host_key LIKE "%.google.com.in" OR host_key LIKE "%.google.co.uk"').fetchall()
    
    target_domains = ['.google.com', '.gemini.google.com']
    replaced = 0

    for row in rows:
        row_dict = dict(zip(cols, row))
        cookie_name = row_dict['name']
        
        for target in target_domains:
            # Force delete any existing/dummy cookie for target domain with this name
            c.execute('DELETE FROM cookies WHERE host_key = ? AND name = ?', (target, cookie_name))
            
            row_dict['host_key'] = target
            placeholders = ', '.join(['?'] * len(cols))
            c.execute(f'INSERT INTO cookies ({", ".join(cols)}) VALUES ({placeholders})', [row_dict[col] for col in cols])
            replaced += 1

    conn.commit()
    conn.close()
    print(f"[copy_cookies] Successfully replaced/copied {replaced} auth cookies to .google.com and .gemini.google.com!")
except Exception as e:
    print(f"[copy_cookies] Error replacing cookies: {e}")
