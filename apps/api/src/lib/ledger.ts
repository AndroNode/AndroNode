import { newId } from "@andronode/protocol/hash";

export interface Posting { account: string; units: bigint }

/**
 * Builds statements for one balanced journal. The event key makes it idempotent:
 * if the event was already journaled, no postings are added. Run inside a D1 batch.
 */
export function journal(db: D1Database, eventKey: string, memo: string, postings: Posting[], at: number): D1PreparedStatement[] {
  const sum = postings.reduce((s, p) => s + p.units, 0n);
  if (sum !== 0n) throw new Error(`Unbalanced journal ${eventKey}: ${sum}`);
  const id = newId("jr");
  return [
    db.prepare("INSERT INTO journals (id, event_key, memo, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING").bind(id, eventKey, memo, at),
    ...postings.map((p) =>
      db.prepare("INSERT INTO postings (journal_id, account, units) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM journals WHERE id = ?)").bind(id, p.account, Number(p.units), id),
    ),
  ];
}

export async function balance(db: D1Database, account: string): Promise<bigint> {
  const r = await db.prepare("SELECT COALESCE(SUM(units), 0) AS s FROM postings WHERE account = ?").bind(account).first<{ s: number }>();
  return BigInt(r?.s ?? 0);
}
