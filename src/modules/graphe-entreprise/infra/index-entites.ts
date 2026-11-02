import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { indexer, trancher, resoudreDans, type CandidatEntite, type IndexEntites, type Resolution } from "../domaine/resolution";
import type { TypeNoeud } from "../domaine/noeuds";
import { perimetreDe } from "./perimetre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INDEX DE RÉSOLUTION (J9, décision 0021) — les fiches canoniques, en mémoire, rechargées toutes les 5 minutes.
 *
 * Ce n'est PAS un registre : une projection jetable des tables qui font foi (Personne, Organisation et ses identifiants,
 * Product et ses alias, RegulatoryProduct, les alias saisis du graphe de connaissance). Les fiches fusionnées
 * (`fusionneeDansId`) n'y entrent pas : on résout vers celle qui est gardée.
 *
 * LES DROITS AVANT LE VERDICT : les candidats sont jugés par le périmètre de la personne AVANT de trancher — un homonyme
 * qu'elle ne peut pas voir ne rend pas sa question ambiguë (ce qui révélerait son existence).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let cache: { index: IndexEntites; charge: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

export function oublierIndex(): void { cache = null; }

async function charger(): Promise<IndexEntites> {
  const [personnes, users, orgs, produits, dossiers, alias] = await Promise.all([
    prisma.personne.findMany({ where: { fusionneeDansId: null }, select: { id: true, nom: true, prenoms: true } }),
    prisma.user.findMany({ where: { personneId: null, isActive: true }, select: { id: true, name: true } }),
    prisma.organisation.findMany({
      where: { fusionneeDansId: null },
      select: { id: true, raisonSociale: true, nomCourt: true, identifiants: { select: { valeurNormalisee: true } }, suppliers: { select: { name: true } }, companies: { select: { name: true } } },
    }),
    prisma.product.findMany({ select: { id: true, canonicalName: true, code: true, dci: true, aliases: { select: { label: true } } } }),
    prisma.regulatoryProduct.findMany({ select: { id: true, reference: true, dci: true, brandName: true, productId: true } }),
    prisma.knowledgeAlias.findMany({
      where: { source: { not: "derived" }, entity: { isActive: true, refType: { in: ["Supplier", "Company"] } } },
      select: { alias: true, entity: { select: { refType: true, refId: true } } },
    }),
  ]);
  const orgDe = new Map<string, string>();
  const [sups, cies] = await Promise.all([
    prisma.supplier.findMany({ where: { organisationId: { not: null } }, select: { id: true, organisationId: true } }),
    prisma.company.findMany({ where: { organisationId: { not: null } }, select: { id: true, organisationId: true } }),
  ]);
  for (const s of sups) orgDe.set(`Supplier:${s.id}`, s.organisationId!);
  for (const c of cies) orgDe.set(`Company:${c.id}`, c.organisationId!);
  const aliasOrg = new Map<string, string[]>();
  for (const a of alias) {
    const o = orgDe.get(`${a.entity.refType}:${a.entity.refId}`);
    if (o) (aliasOrg.get(o) ?? aliasOrg.set(o, []).get(o)!).push(a.alias);
  }
  const c: CandidatEntite[] = [];
  for (const p of personnes) c.push({ ref: `PERSONNE:${p.id}`, type: "PERSONNE", libelle: [p.prenoms, p.nom].filter(Boolean).join(" ") });
  for (const u of users) c.push({ ref: `PERSONNE:u:${u.id}`, type: "PERSONNE", libelle: u.name });
  for (const o of orgs) {
    const alias = [o.nomCourt, ...o.suppliers.map((s) => s.name), ...o.companies.map((x) => x.name), ...(aliasOrg.get(o.id) ?? [])]
      .filter((x): x is string => !!x && x !== o.raisonSociale);
    c.push({ ref: `ORGANISATION:${o.id}`, type: "ORGANISATION", libelle: o.raisonSociale, alias: [...new Set(alias)], identifiants: o.identifiants.map((i) => i.valeurNormalisee) });
  }
  for (const p of produits) c.push({ ref: `PRODUIT:${p.id}`, type: "PRODUIT", libelle: p.canonicalName, alias: [p.code, ...p.aliases.map((a) => a.label)], detail: p.dci });
  for (const d of dossiers) c.push({ ref: `DOSSIER:${d.id}`, type: "DOSSIER", libelle: d.brandName ? `${d.brandName} ${d.dci}` : d.dci, alias: [d.reference, ...(d.brandName ? [d.brandName] : [])], detail: d.reference, parent: d.productId ? `PRODUIT:${d.productId}` : null });
  return indexer(c);
}

export async function indexEntites(): Promise<IndexEntites> {
  if (cache && Date.now() - cache.charge < TTL_MS) return cache.index;
  const index = await charger();
  cache = { index, charge: Date.now() };
  return index;
}

/** RÉSOUT une mention pour une personne : types ouverts, candidats jugés par ses droits, puis le verdict. */
export async function resoudreEntite(user: SessionUser, mention: string, o: { types?: readonly TypeNoeud[]; exclus?: readonly TypeNoeud[]; pourModele?: boolean } = {}): Promise<Resolution> {
  const perimetre = perimetreDe(user, { exclus: o.exclus, pourModele: o.pourModele });
  const types = [...perimetre.types].filter((t) => !o.types?.length || o.types.includes(t));
  const index = await indexEntites();
  const large = resoudreDans(index, mention.slice(0, 200), { types, limite: 20 });
  if (!large.candidats.length) return large;
  const ok = await perimetre.autoriser(large.candidats.map((c) => c.candidat.ref));
  return trancher(large.candidats.filter((c) => ok.has(c.candidat.ref)));
}
