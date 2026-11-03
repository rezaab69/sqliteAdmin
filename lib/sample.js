// Creates a small demo database so the panel has something to show on first run.
import { DatabaseSync } from 'node:sqlite';

const PNG_DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function createSampleDatabase(file) {
  const db = new DatabaseSync(file);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      country TEXT,
      formed_year INTEGER CHECK (formed_year > 1900)
    );
    CREATE TABLE albums (
      id INTEGER PRIMARY KEY,
      artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      released DATE,
      price REAL DEFAULT 9.99 CHECK (price >= 0)
    );
    CREATE INDEX idx_albums_artist ON albums(artist_id);
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY,
      album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      duration_sec INTEGER,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5)
    );
    CREATE INDEX idx_tracks_album ON tracks(album_id);
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE COLLATE NOCASE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      avatar BLOB
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      ordered_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
      total REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      album_id INTEGER NOT NULL REFERENCES albums(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      PRIMARY KEY (order_id, album_id)
    ) WITHOUT ROWID;
    CREATE TRIGGER order_items_total AFTER INSERT ON order_items
    BEGIN
      UPDATE orders SET total = round(total + NEW.quantity * NEW.unit_price, 2) WHERE id = NEW.order_id;
    END;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE VIEW album_summary AS
      SELECT al.id, ar.name AS artist, al.title, al.released, count(t.id) AS tracks,
             sum(t.duration_sec) AS total_seconds, round(avg(t.rating), 2) AS avg_rating
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      LEFT JOIN tracks t ON t.album_id = al.id
      GROUP BY al.id;
  `);

  const artists = [
    ['The Midnight Owls', 'UK', 1998], ['Neon Harbor', 'USA', 2009], ['Sól og Máni', 'Iceland', 2014],
    ['Los Relámpagos', 'Mexico', 1987], ['Kyoto Drift', 'Japan', 2011], ['Velvet Static', 'Canada', 2003],
    ['Die Nachtfalter', 'Germany', 1994], ['Blue Meridian', 'Australia', 2016], ['Sahara Echo', 'Morocco', 2008],
    ['Paper Lanterns', 'USA', 2019], ['Aurora Tide', 'Norway', 2001], ['Copper & Coal', 'Ireland', 1991],
  ];
  const words = ['Midnight', 'Echo', 'River', 'Glass', 'Summer', 'Static', 'Golden', 'Hollow', 'Silver', 'Northern',
    'Paper', 'Electric', 'Quiet', 'Wild', 'Lost', 'Velvet', 'Ember', 'Ocean', 'Neon', 'Distant'];
  const nouns = ['Lights', 'Dreams', 'Roads', 'Hearts', 'Skies', 'Waves', 'Signals', 'Gardens', 'Stories', 'Mirrors',
    'Horizons', 'Shadows', 'Voices', 'Cities', 'Fires'];
  const first = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Mateo', 'Sofia', 'Yuki', 'Amara', 'Lucas', 'Chloe', 'Ethan',
    'Isla', 'Omar', 'Priya', 'Leo', 'Mia', 'Hugo', 'Zara', 'Kai'];
  const last = ['Smith', 'García', 'Müller', 'Tanaka', 'Okafor', 'Rossi', 'Nguyen', 'Johansson', 'Kowalski', 'Silva',
    'Dubois', 'Patel', 'Cohen', 'Novak', "O'Brien"];

  db.exec('BEGIN');
  const insArtist = db.prepare('INSERT INTO artists (name, country, formed_year) VALUES (?, ?, ?)');
  for (const a of artists) insArtist.run(...a);

  const insAlbum = db.prepare('INSERT INTO albums (artist_id, title, released, price) VALUES (?, ?, ?, ?)');
  const insTrack = db.prepare('INSERT INTO tracks (album_id, title, duration_sec, rating) VALUES (?, ?, ?, ?)');
  let albumCount = 0;
  for (let artistId = 1; artistId <= artists.length; artistId++) {
    const n = int(2, 4);
    for (let i = 0; i < n; i++) {
      const year = int(Math.max(artists[artistId - 1][2], 1990), 2025);
      const r = insAlbum.run(artistId, `${pick(words)} ${pick(nouns)}`,
        `${year}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
        pick([7.99, 9.99, 11.99, 12.49, 14.99]));
      albumCount++;
      const tracks = int(6, 12);
      for (let t = 0; t < tracks; t++) {
        insTrack.run(r.lastInsertRowid, `${pick(words)} ${pick(nouns).toLowerCase()}`, int(120, 420), rand() < 0.15 ? null : int(1, 5));
      }
    }
  }

  const insCustomer = db.prepare('INSERT INTO customers (first_name, last_name, email, created_at, avatar) VALUES (?, ?, ?, ?, ?)');
  const avatar = new Uint8Array(Buffer.from(PNG_DOT, 'base64'));
  for (let i = 1; i <= 60; i++) {
    const f = pick(first);
    const l = pick(last);
    insCustomer.run(f, l, `${f}.${l.replace(/[^A-Za-z]/g, '')}${i}@example.com`.toLowerCase(),
      `2024-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')} ${String(int(0, 23)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00`,
      i % 7 === 0 ? avatar : null);
  }

  const insOrder = db.prepare('INSERT INTO orders (customer_id, ordered_at, status) VALUES (?, ?, ?)');
  const insItem = db.prepare('INSERT OR IGNORE INTO order_items (order_id, album_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
  const price = db.prepare('SELECT price FROM albums WHERE id = ?');
  for (let i = 1; i <= 150; i++) {
    const r = insOrder.run(int(1, 60), `2025-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      pick(['pending', 'paid', 'paid', 'shipped', 'shipped', 'cancelled']));
    const items = int(1, 4);
    for (let j = 0; j < items; j++) {
      const albumId = int(1, albumCount);
      insItem.run(r.lastInsertRowid, albumId, int(1, 3), price.get(albumId).price);
    }
  }

  const insSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insSetting.run('store_name', 'Vinyl & Bytes');
  insSetting.run('currency', 'USD');
  insSetting.run('features', JSON.stringify({ wishlist: true, reviews: false, max_cart_items: 25 }));
  db.exec('COMMIT');
  db.exec('PRAGMA user_version = 1');
  db.close();
}
