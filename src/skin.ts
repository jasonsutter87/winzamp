// Classic Winamp skins (.wsz): a zip of BMP sprite sheets plus a few text
// files. We load the bitmaps the main window needs and viscolor.txt; anything
// a skin leaves out falls back to the base skin, as Winamp itself does.
//
// The curated skins come from the Winamp Skin Museum (skins.webamp.org) and
// are downloaded on first use, then cached in IndexedDB, rather than shipped
// in the repo: they're their authors' work.
import { unzipSync } from "fflate";

export interface MuseumSkin {
  md5: string;
  name: string;
}

export const BASE_SKIN: MuseumSkin = { md5: "5e4f10275dcb1fb211d4a8b4f1bda236", name: "Winamp Classic (base 2.91)" };

/** The curated picks, in menu order. */
export const MUSEUM_SKINS: MuseumSkin[] = [
  BASE_SKIN,
  { md5: "b0fb83cc20af3abe264291bb17fb2a13", name: "Winamp5 Classified" },
  { md5: "d6010aa35bed659bc1311820daa4b341", name: "Bento Classified" },
  { md5: "d770a634cc1ab252cfb16c64f4f5f616", name: "Zelda Amp III" },
  { md5: "80fb8e391fc925f297174a8fd9c5b6ad", name: "Fallout Pip-Boy 2000" },
  { md5: "7b9df7892503371430aaf99ea7a172c0", name: "Unreal" },
  { md5: "3e5f4c237cbad07fce684f0e171abe6a", name: "Super Mario Land (Game Boy)" },
  { md5: "e06363340d1e7db147b2b61e9c3601a4", name: "ASCII Telnet" },
  { md5: "cb7102ec7a4f6cefbc63d0dc0aecea16", name: "Purple Glow" },
  { md5: "bb7fd9baf2292c81436825248837acc7", name: "Blue Jeans" },
];

const CDN = "https://r2.webampskins.org/skins";

/** Sprite sheets the main window draws from. */
export const SHEETS = [
  "main",
  "titlebar",
  "cbuttons",
  "numbers",
  "nums_ex",
  "text",
  "playpaus",
  "monoster",
  "posbar",
  "volume",
  "balance",
  "shufrep",
] as const;
export type SheetName = (typeof SHEETS)[number];

export type Rgb = [number, number, number];

export interface Skin {
  sheets: Partial<Record<SheetName, ImageBitmap>>;
  /** viscolor.txt: 24 colors (see classicVis.ts for the slot meanings). */
  viscolor: Rgb[] | null;
}

// --- IndexedDB cache of raw .wsz bytes --------------------------------------

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("winzamp-skins", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("wsz");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key: string): Promise<ArrayBuffer | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction("wsz").objectStore("wsz").get(key);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cachePut(key: string, bytes: ArrayBuffer): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const tx = d.transaction("wsz", "readwrite");
      tx.objectStore("wsz").put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Cache unavailable; we'll just download again next time.
  }
}

/** Raw .wsz bytes for a museum skin: cache first, else download and cache. */
async function museumBytes(md5: string): Promise<ArrayBuffer> {
  const cached = await cacheGet(md5);
  if (cached) return cached;
  const res = await fetch(`${CDN}/${md5}.wsz`);
  if (!res.ok) throw new Error(`skin download failed (${res.status})`);
  const bytes = await res.arrayBuffer();
  await cachePut(md5, bytes);
  return bytes;
}

/** Bytes of a .wsz the user loaded themselves (stored under "custom"). */
export const customBytes = () => cacheGet("custom");

// --- parsing ----------------------------------------------------------------

/** viscolor.txt lines look like "24,33,41, // comment"; take the first 3 ints. */
function parseViscolor(text: string): Rgb[] | null {
  const colors: Rgb[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)/);
    if (m) colors.push([+m[1], +m[2], +m[3]]);
    if (colors.length === 24) return colors;
  }
  return null;
}

/** Unzip a .wsz and decode the sheets it has. Lookup ignores case and folders. */
export async function parseWsz(bytes: ArrayBuffer): Promise<Skin> {
  const files = unzipSync(new Uint8Array(bytes));
  const byName = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    byName.set(path.split("/").pop()!.toLowerCase(), data);
  }

  const sheets: Skin["sheets"] = {};
  await Promise.all(
    SHEETS.map(async (name) => {
      const data = byName.get(`${name}.bmp`);
      if (!data) return;
      try {
        sheets[name] = await createImageBitmap(new Blob([data as BlobPart], { type: "image/bmp" }));
      } catch {
        // Undecodable bitmap: fall back to the base skin's sheet.
      }
    }),
  );
  const vis = byName.get("viscolor.txt");
  return { sheets, viscolor: vis ? parseViscolor(new TextDecoder().decode(vis)) : null };
}

let base: Promise<Skin> | null = null;

/** Layer a skin over the base skin so missing sheets still draw. */
async function withBase(skin: Skin): Promise<Skin> {
  base ??= museumBytes(BASE_SKIN.md5).then(parseWsz);
  const b = await base;
  return { sheets: { ...b.sheets, ...skin.sheets }, viscolor: skin.viscolor ?? b.viscolor };
}

export async function loadMuseumSkin(md5: string): Promise<Skin> {
  return withBase(await parseWsz(await museumBytes(md5)));
}

export async function loadSkinBytes(bytes: ArrayBuffer): Promise<Skin> {
  return withBase(await parseWsz(bytes));
}
