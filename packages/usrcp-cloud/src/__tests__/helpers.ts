import { newDb, type IMemoryDb } from "pg-mem";
import * as crypto from "node:crypto";
import { Db, type PoolLike } from "../db.js";

export function makeMemDb(): { db: Db; mem: IMemoryDb } {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as PoolLike;
  const db = new Db(pool);
  return { db, mem };
}

export function makeKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey as string, publicKeyPem: publicKey as string };
}
