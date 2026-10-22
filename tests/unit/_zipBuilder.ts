// Minimal in-memory ZIP writer for synthetic edge-case archives in tests.
import { crc32, deflateRawSync } from "node:zlib";

export interface BuildEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  localCrc?: number;
  localSizes?: [number, number];
  centralCrc?: number;
  centralUncompressed?: number;
}

/** Minimal ZIP writer for synthetic edge cases. */
export function buildZip(
  entries: BuildEntry[],
  eocd: { disk?: number; entriesOnDisk?: number; total?: number; cdSize?: number; cdOffset?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const payload = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const flags = e.flags ?? 0;
    const crc = e.centralCrc ?? crc32(e.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(e.localCrc ?? crc, 14);
    lfh.writeUInt32LE(e.localSizes?.[0] ?? payload.length, 18);
    lfh.writeUInt32LE(e.localSizes?.[1] ?? e.centralUncompressed ?? e.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lfh, name, payload]);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(e.centralUncompressed ?? e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cdh, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.disk ?? 0, 4);
  end.writeUInt16LE(eocd.entriesOnDisk ?? entries.length, 8);
  end.writeUInt16LE(eocd.total ?? entries.length, 10);
  end.writeUInt32LE(eocd.cdSize ?? cd.length, 12);
  end.writeUInt32LE(eocd.cdOffset ?? offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
