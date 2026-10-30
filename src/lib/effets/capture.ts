import { Prisma } from "@prisma/client";
import { sansBloquer } from "@/lib/journal";
import { etatDuGeste, type Capture, type EcritureCapturee } from "./magasin";
import { infoModele, MODELES_TRACE, type InfoModele } from "./modeles";
import { champsChanges, serialiserLigne } from "./valeurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAPTURE DES ÉCRITURES (J7, décision 0029) — une extension Prisma, posée sur le client du geste.
 *
 * Pendant un geste d'agent (simulation, ou geste réel journalisé), CHAQUE écriture passe ici et laisse sa trace :
 * le modèle, l'identifiant, la ligne AVANT (lue juste avant l'écriture), la ligne APRÈS, les champs touchés.
 * C'est la matière de deux choses : le DIFF que la carte montre (simulation) et le JOURNAL DES EFFETS qu'une
 * annulation relit (réel).
 *
 * ── CE QUE LA CAPTURE NE CHANGE PAS ──────────────────────────────────────────────────────
 *
 * Le résultat rendu à l'action est EXACTEMENT celui qu'elle aurait reçu : quand elle restreint sa lecture
 * (`select`), la capture élargit la requête aux champs scalaires pour connaître la ligne après, puis rend la forme
 * demandée. Une écriture hors de tout geste ne passe par aucune lecture de plus.
 *
 * ── OÙ LA LIGNE « AVANT » EST LUE ────────────────────────────────────────────────────────
 *
 * En simulation : dans la transaction du geste (elle voit ce que le geste vient d'écrire). En réel : sur le client
 * de base, hors de la transaction éventuelle de l'action — c'est la valeur ENGAGÉE avant le geste, celle que
 * l'annulation doit rendre (une ligne écrite deux fois dans le même geste garde son tout premier « avant »).
 *
 * ── CE QUI N'EST PAS DÉTAILLÉ, ET LE DIT ─────────────────────────────────────────────────
 *
 * Une création en lot (`createMany`) n'a pas d'identifiants : elle est comptée. Une écriture imbriquée (la relation
 * créée par la même requête) est signalée `imbriquee`. Du SQL brut (`$executeRaw`) est noté « SQL » : il se simule
 * (la transaction l'annule) mais ne se défait pas depuis le journal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ECRITURES = new Set(["create", "update", "upsert", "delete", "createMany", "createManyAndReturn", "updateMany", "deleteMany"]);
const SQL_BRUT = new Set(["$executeRaw", "$executeRawUnsafe"]);
const SQL_LECTURE = new Set(["$queryRaw", "$queryRawUnsafe"]);
/** Une requête « de lecture » qui ÉCRIT (`UPDATE … RETURNING` par `$queryRaw`) : notée comme du SQL brut. */
const SQL_ECRIT = /^\s*(with\b[\s\S]*\b)?(insert|update|delete|merge)\b/i;
const texteSql = (args: unknown): string => {
  if (typeof args === "string") return args;
  if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : Array.isArray(args[0]) ? (args[0] as string[]).join("?") : "";
  const o = args as { strings?: readonly string[]; sql?: string } | null;
  return o?.sql ?? o?.strings?.join("?") ?? "";
};
/** Au-delà, une écriture en lot est comptée sans lire chaque ligne (une campagne de 10 000 lignes ne se diffe pas). */
const LOT_MAX = 500;

type Delegue = {
  findUnique: (a: unknown) => Promise<Record<string, unknown> | null>;
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  count: (a: unknown) => Promise<number>;
};
type Client = Record<string, unknown>;

const NESTED = /^(create|createMany|connectOrCreate|upsert|update|updateMany|delete|deleteMany|set|disconnect)$/;

function imbriquee(info: InfoModele, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const lignes = Array.isArray(data) ? data : [data];
  return lignes.some((l) => Object.entries(l as Record<string, unknown>).some(([k, v]) =>
    info.relations.has(k) && v && typeof v === "object" && Object.keys(v as object).some((op) => NESTED.test(op))));
}

const selectionScalaires = (info: InfoModele) => Object.fromEntries(info.scalaires.map((s) => [s, true]));

/** Élargit un `select` aux scalaires ; rend la fonction qui ramène le résultat à la forme demandée. */
function elargir(info: InfoModele, args: Record<string, unknown>): { args: Record<string, unknown>; rendre: (r: unknown) => unknown } {
  const select = args.select as Record<string, unknown> | undefined;
  if (!select) return { args, rendre: (r) => r };
  const demandes = new Set(Object.keys(select).filter((k) => select[k]));
  return {
    args: { ...args, select: { ...selectionScalaires(info), ...select } },
    rendre: (r) => (r && typeof r === "object" ? Object.fromEntries(Object.entries(r as object).filter(([k]) => demandes.has(k))) : r),
  };
}

async function compterCascades(lecteur: Client, info: InfoModele, id: string): Promise<number> {
  let n = 0;
  for (const c of info.cascades) {
    const d = lecteur[c.delegue] as Delegue | undefined;
    if (d) n += await d.count({ where: { [c.champ]: id } }).catch(sansBloquer("effets.capture.compte", 0));
  }
  return n;
}

/** Une clé au format des `cuid()` du schéma (une lettre, puis 24 caractères base 36). */
const nouvelId = (): string => `c${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/**
 * LES ENFANTS NÉS AVEC LEUR PARENT — une création imbriquée (`participants: { create: […] }`) : la ligne parente
 * vient de naître, donc TOUT ce qui pointe déjà vers elle est né par la même requête. Chaque enfant devient une création
 * nommée (l'annulation le retire avant son parent, dans l'ordre inverse).
 */
async function noterEnfantsNes(lecteur: Client, info: InfoModele, id: string, noter: (e: EcritureCapturee) => void): Promise<void> {
  for (const lien of info.enfants) {
    const enfant = infoModele(lien.modele);
    const d = lecteur[lien.delegue] as Delegue | undefined;
    if (!enfant || !d || MODELES_TRACE.has(lien.modele)) continue;
    const lignes = await d.findMany({ where: { [lien.champ]: id }, take: LOT_MAX }).catch(sansBloquer("effets.capture.lecture", [] as Record<string, unknown>[]));
    for (const l of lignes) {
      const apres = serialiserLigne(l, new Set(enfant.scalaires));
      noter({ modele: lien.modele, operation: "CREATE", id: versId(enfant, l), avant: null, apres, champs: Object.keys(apres ?? {}).sort() });
    }
  }
}

const versId = (info: InfoModele, ligne: Record<string, unknown> | null): string | null =>
  info.cle && ligne && ligne[info.cle] != null ? String(ligne[info.cle]) : null;

/**
 * L'EXTENSION. `brut` est le client de base, sans extension : en réel, les lignes « avant » s'y lisent ; en
 * simulation, le client du geste (la transaction) les lit.
 */
export function extensionCapture(brut: Client) {
  return Prisma.defineExtension({
    name: "amd-capture-effets",
    query: {
      async $allOperations({ model, operation, args, query }) {
        const etat = etatDuGeste();
        const capture = etat?.capture;
        if (!capture) return query(args);
        // LE CALME DU GESTE : chaque requête compte, pour attendre la fin d'une promesse « au mieux » (`finaliserCapture`).
        capture.enVol = (capture.enVol ?? 0) + 1;
        try {
          return await capturer(etat, capture, brut, model, operation, args, query);
        } finally {
          capture.enVol = (capture.enVol ?? 1) - 1;
          capture.derniere = Date.now();
        }
      },
    },
  });
}

async function capturer(
  etat: NonNullable<ReturnType<typeof etatDuGeste>>, capture: NonNullable<NonNullable<ReturnType<typeof etatDuGeste>>["capture"]>,
  brut: Client, model: string | undefined, operation: string, args: unknown, query: (a: unknown) => Promise<unknown>,
): Promise<unknown> {
        if (!model) {
          if (!SQL_BRUT.has(operation) && !(SQL_LECTURE.has(operation) && SQL_ECRIT.test(texteSql(args)))) return query(args);
          const r = await query(args);
          // La table, quand le texte la nomme (« UPDATE "FileBlob" … ») : les octets d'une pièce ne se lisent pas comme une écriture métier.
          const table = /\b(?:update|into|from)\s+"?([A-Za-z_]\w*)"?/i.exec(texteSql(args))?.[1] ?? "SQL";
          capture.ecritures.push({ modele: table, operation: "SQL", id: null, avant: null, apres: null, champs: [], nombre: typeof r === "number" ? r : Array.isArray(r) ? r.length : undefined });
          return r;
        }
        if (!ECRITURES.has(operation) || MODELES_TRACE.has(model)) return query(args);
        const info = infoModele(model);
        if (!info) return query(args);
        const lecteur = (etat.mode === "SIMULATION" ? etat.client : brut) as Client;
        const d = lecteur[info.delegue] as Delegue;
        const a = (args ?? {}) as Record<string, unknown>;
        const garder = new Set(info.scalaires);
        const noter = (e: EcritureCapturee) => { capture.ecritures.push(e); capture.tardive?.(e); };
        // Une création EN LOT sans identifiants : comptée, jamais devinée.
        const enLot = async () => {
          const r = (await query(a)) as { count?: number };
          noter({ modele: model, operation: "CREATE", id: null, avant: null, apres: null, champs: [], nombre: r?.count });
          return r;
        };

        switch (operation) {
          case "create": {
            const { args: elargi, rendre } = elargir(info, a);
            const r = (await query(elargi)) as Record<string, unknown>;
            const apres = serialiserLigne(r, garder);
            const id = versId(info, r);
            const nested = imbriquee(info, a.data);
            noter({ modele: model, operation: "CREATE", id, avant: null, apres, champs: Object.keys(apres ?? {}).sort(), imbriquee: nested || undefined });
            if (nested && id) await noterEnfantsNes(lecteur, info, id, noter);
            return rendre(r);
          }
          case "update":
          case "upsert": {
            const avantBrut = await d.findUnique({ where: a.where }).catch(sansBloquer("effets.capture.lecture", null));
            const { args: elargi, rendre } = elargir(info, a);
            const r = (await query(elargi)) as Record<string, unknown>;
            const avant = serialiserLigne(avantBrut, garder);
            const apres = serialiserLigne(r, garder);
            const nested = imbriquee(info, operation === "upsert" ? [a.create, a.update] : a.data);
            const id = versId(info, r) ?? versId(info, avantBrut);
            noter({
              modele: model, operation: avantBrut ? "UPDATE" : "CREATE", id,
              avant, apres, champs: avantBrut ? champsChanges(avant, apres) : Object.keys(apres ?? {}).sort(), imbriquee: nested || undefined,
            });
            if (!avantBrut && nested && id) await noterEnfantsNes(lecteur, info, id, noter);
            return rendre(r);
          }
          case "delete": {
            const avantBrut = await d.findUnique({ where: a.where }).catch(sansBloquer("effets.capture.lecture", null));
            const id = versId(info, avantBrut);
            const cascade = id ? await compterCascades(lecteur, info, id) : 0;
            const r = await query(a);
            noter({ modele: model, operation: "DELETE", id, avant: serialiserLigne(avantBrut, garder), apres: null, champs: [], cascade: cascade || undefined });
            return r;
          }
          case "updateMany": {
            const lignes = info.cle ? await d.findMany({ where: a.where, take: LOT_MAX + 1 }).catch(sansBloquer("effets.capture.lecture", [] as Record<string, unknown>[])) : [];
            const r = (await query(a)) as { count?: number };
            if (!info.cle || lignes.length > LOT_MAX) {
              noter({ modele: model, operation: "UPDATE", id: null, avant: null, apres: null, champs: Object.keys((a.data as object) ?? {}).sort(), nombre: r?.count });
              return r;
            }
            const ids = lignes.map((l) => l[info.cle!]);
            const apresTous = ids.length ? await d.findMany({ where: { [info.cle]: { in: ids } } }).catch(sansBloquer("effets.capture.lecture", [] as Record<string, unknown>[])) : [];
            const parId = new Map(apresTous.map((l) => [String(l[info.cle!]), l]));
            for (const l of lignes) {
              const id = String(l[info.cle]);
              const avant = serialiserLigne(l, garder);
              const apres = serialiserLigne(parId.get(id) ?? null, garder);
              const champs = champsChanges(avant, apres);
              if (champs.length) noter({ modele: model, operation: "UPDATE", id, avant, apres, champs });
            }
            return r;
          }
          case "deleteMany": {
            const lignes = info.cle ? await d.findMany({ where: a.where, take: LOT_MAX + 1 }).catch(sansBloquer("effets.capture.lecture", [] as Record<string, unknown>[])) : [];
            if (!info.cle || lignes.length > LOT_MAX) {
              const r = (await query(a)) as { count?: number };
              noter({ modele: model, operation: "DELETE", id: null, avant: null, apres: null, champs: [], nombre: r?.count });
              return r;
            }
            const cascades = await Promise.all(lignes.map((l) => compterCascades(lecteur, info, String(l[info.cle!]))));
            const r = await query(a);
            lignes.forEach((l, i) => noter({
              modele: model, operation: "DELETE", id: String(l[info.cle!]), avant: serialiserLigne(l, garder), apres: null, champs: [], cascade: cascades[i] || undefined,
            }));
            return r;
          }
          case "createManyAndReturn": {
            const r = (await query(a)) as Record<string, unknown>[];
            for (const l of r ?? []) {
              const apres = serialiserLigne(l, garder);
              noter({ modele: model, operation: "CREATE", id: versId(info, l), avant: null, apres, champs: Object.keys(apres ?? {}).sort() });
            }
            return r;
          }
          case "createMany": {
            // LES IDENTIFIANTS FIXÉS AVANT L'ÉCRITURE : une clé tirée par défaut (`cuid()`) est tirée ici, et chaque
            // ligne du lot devient une création nommée — relue dans la transaction en simulation.
            const lignesData = (Array.isArray(a.data) ? a.data : [a.data]) as Record<string, unknown>[];
            const clesFournies = !!info.cle && lignesData.every((l) => l[info.cle!] != null);
            if (!info.cle || (!info.cleGeneree && !clesFournies) || lignesData.length > LOT_MAX) return enLot();
            const nommees = lignesData.map((l) => (l[info.cle!] ? l : { ...l, [info.cle!]: nouvelId() }));
            const r = (await query({ ...a, data: nommees })) as { count?: number };
            const ids = nommees.map((l) => String(l[info.cle!]));
            const relues = etat.mode === "SIMULATION" ? await d.findMany({ where: { [info.cle]: { in: ids } } }).catch(sansBloquer("effets.capture.lecture", [] as Record<string, unknown>[])) : [];
            const parId = new Map(relues.map((l) => [String(l[info.cle!]), l]));
            for (const [i, id] of ids.entries()) {
              if (relues.length && !parId.has(id)) continue; // écartée par `skipDuplicates`
              const apres = serialiserLigne(parId.get(id) ?? nommees[i], garder);
              noter({ modele: model, operation: "CREATE", id, avant: null, apres, champs: Object.keys(apres ?? {}).sort() });
            }
            return r;
          }
          default:
            return enLot();
        }
}

/**
 * LA FIN D'UN GESTE — attendre le CALME (plus aucune requête en vol depuis un court instant : une promesse lancée sans
 * être attendue, comme le miroir d'une pièce au Drive, finit son travail), puis relire l'état FINAL des lignes créées ou
 * modifiées (une écriture SQL ou imbriquée a pu les retoucher dans le même geste). Borné : jamais plus de `maxMs`.
 */
export async function finaliserCapture(capture: Capture, lecteur: Client, opts: { calmeMs?: number; maxMs?: number } = {}): Promise<void> {
  const calme = opts.calmeMs ?? 150;
  const fin = Date.now() + (opts.maxMs ?? 3_000);
  await new Promise((r) => setTimeout(r, 25));
  while (Date.now() < fin && ((capture.enVol ?? 0) > 0 || Date.now() - (capture.derniere ?? 0) < calme)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const parModele = new Map<string, EcritureCapturee[]>();
  for (const e of capture.ecritures) {
    if (!e.id || (e.operation !== "CREATE" && e.operation !== "UPDATE")) continue;
    parModele.set(e.modele, [...(parModele.get(e.modele) ?? []), e]);
  }
  for (const [modele, ecritures] of parModele) {
    const info = infoModele(modele);
    const d = info?.cle ? (lecteur[info.delegue] as Delegue | undefined) : undefined;
    if (!info?.cle || !d) continue;
    const lignes = await d.findMany({ where: { [info.cle]: { in: [...new Set(ecritures.map((e) => e.id))] } } }).catch(sansBloquer("effets.capture.lecture", null));
    if (!lignes) continue;
    const parId = new Map(lignes.map((l) => [String(l[info.cle!]), serialiserLigne(l, new Set(info.scalaires))]));
    for (const e of ecritures) {
      const finale = parId.get(e.id!);
      if (!finale) continue;
      e.apres = finale;
      e.champs = e.operation === "UPDATE" ? champsChanges(e.avant, finale) : Object.keys(finale).sort();
    }
  }
}
