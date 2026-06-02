import sqlite3


def init_db(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS seen_properties (
        property_id TEXT PRIMARY KEY,
        source TEXT,
        url TEXT,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS property_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id TEXT,
        source TEXT,
        url TEXT,
        search_name TEXT,
        price TEXT,
        address TEXT,
        image TEXT,
        reason TEXT,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_sent INTEGER DEFAULT 0
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS search_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        source TEXT,
        search_name TEXT,
        properties_found INTEGER DEFAULT 0,
        properties_emailed INTEGER DEFAULT 0,
        status TEXT,
        error_message TEXT
    )
    """)

    conn.commit()
    return conn


def property_seen(conn, property_id):
    cursor = conn.cursor()

    cursor.execute(
        "SELECT property_id FROM seen_properties WHERE property_id = ?",
        (property_id,)
    )

    return cursor.fetchone() is not None


def save_property(conn, property_id, source, url):
    cursor = conn.cursor()

    cursor.execute("""
    INSERT OR IGNORE INTO seen_properties (
        property_id,
        source,
        url
    )
    VALUES (?, ?, ?)
    """, (property_id, source, url))

    conn.commit()


def save_property_result(conn, record):
    cursor = conn.cursor()

    cursor.execute("""
    INSERT INTO property_results (
        property_id,
        source,
        url,
        search_name,
        price,
        address,
        image,
        reason,
        email_sent
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        record.get("id"),
        record.get("source"),
        record.get("url"),
        record.get("search_name"),
        record.get("price"),
        record.get("address"),
        record.get("image"),
        record.get("reason"),
        1
    ))

    conn.commit()


def log_search_run(
    conn,
    source,
    search_name,
    properties_found,
    properties_emailed,
    status="success",
    error_message=""
):
    cursor = conn.cursor()

    cursor.execute("""
    INSERT INTO search_runs (
        source,
        search_name,
        properties_found,
        properties_emailed,
        status,
        error_message
    )
    VALUES (?, ?, ?, ?, ?, ?)
    """, (
        source,
        search_name,
        properties_found,
        properties_emailed,
        status,
        error_message
    ))

    conn.commit()