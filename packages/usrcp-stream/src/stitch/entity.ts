import type { Ledger } from "usrcp-core/ledger";

export interface EntityResolver {
  resolve(content: string): Promise<string[]>;
}

// Resolves entity references (project IDs etc.) by case-insensitively
// substring-matching the content against active project names and aliases
// in the linked Ledger. Best-effort: failures return an empty array, the
// caller continues to capture with whatever entity_refs were supplied
// explicitly.
export function makeLedgerEntityResolver(ledger: Ledger): EntityResolver {
  return {
    async resolve(content: string): Promise<string[]> {
      try {
        const projects = ledger.getProjects("active");
        const lc = content.toLowerCase();
        const hits = new Set<string>();
        for (const p of projects) {
          const aliases: string[] = [
            p.name,
            ...((p as { aliases?: string[] }).aliases ?? []),
          ];
          for (const alias of aliases) {
            if (!alias) continue;
            if (alias.length < 3) continue;
            if (lc.includes(alias.toLowerCase())) {
              hits.add(p.project_id);
              break;
            }
          }
        }
        return Array.from(hits);
      } catch {
        return [];
      }
    },
  };
}

// Fallback resolver for tests and standalone-stream usage where no Ledger
// is wired in.
export const NoopEntityResolver: EntityResolver = {
  async resolve(): Promise<string[]> {
    return [];
  },
};
