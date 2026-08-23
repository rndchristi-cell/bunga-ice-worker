PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  category_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  base_price INTEGER NOT NULL CHECK (base_price >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  alt_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS variant_groups (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input_type TEXT NOT NULL DEFAULT 'radio',
  is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_delta INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  FOREIGN KEY (group_id) REFERENCES variant_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  pickup_day TEXT NOT NULL,
  pickup_time TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'menunggu_bukti',
  total INTEGER NOT NULL CHECK (total >= 0),
  telegram_chat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT,
  product_name_snapshot TEXT NOT NULL,
  unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  variants_json TEXT NOT NULL DEFAULT '[]',
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_active_order ON products(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_images_product_order ON product_images(product_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_groups_product_order ON variant_groups(product_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_variants_group_order ON variants(group_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('CAT-MAIN', 'Menu', 1);

INSERT OR IGNORE INTO products (id, category_id, name, slug, description, base_price, sort_order)
VALUES
  ('P001', 'CAT-MAIN', 'POP ICE', 'pop-ice', 'Pop Ice Blender Banyak Pilihan Rasa dan Topping', 7000, 1),
  ('P002', 'CAT-MAIN', 'MIE AYAM CUP', 'mie-ayam-cup', 'Mie Ayam komplit + pangsit', 8000, 2);

INSERT OR IGNORE INTO variant_groups (id, product_id, name, input_type, is_required, sort_order)
VALUES
  ('VG-P001-RASA', 'P001', 'Rasa', 'radio', 1, 1),
  ('VG-P001-CUP', 'P001', 'Ukuran Cup', 'radio', 1, 2);

INSERT OR IGNORE INTO variants (id, group_id, name, price_delta, sort_order)
VALUES
  ('V001', 'VG-P001-RASA', 'COKLAT', 0, 1),
  ('V002', 'VG-P001-RASA', 'STRAWBERRY', 0, 2),
  ('V003', 'VG-P001-RASA', 'SUSU', 0, 3),
  ('V004', 'VG-P001-RASA', 'DURIAN', 0, 4),
  ('V005', 'VG-P001-RASA', 'AVOCADO', 0, 5),
  ('V006', 'VG-P001-RASA', 'PERMEN KARET', 0, 6),
  ('V007', 'VG-P001-RASA', 'OREO', 0, 7),
  ('V008', 'VG-P001-RASA', 'VANILLA', 0, 8),
  ('V009', 'VG-P001-RASA', 'ES DOGER', 0, 9),
  ('V010', 'VG-P001-CUP', 'REGULER', 0, 1),
  ('V011', 'VG-P001-CUP', 'BESAR', 2000, 2);

INSERT OR IGNORE INTO store_settings (key, value) VALUES
  ('store_name', 'Bunga Ice and Snack'),
  ('whatsapp_number', '6283893344664'),
  ('qris_asset_key', 'branding/qris-bunga-ice.png');
