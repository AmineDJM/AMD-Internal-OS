/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSOLUTION D'ENTITÉS — la brique qui LIT (F9, mandat 4 §24).
 *
 * Une mention (« Hetero », « Cherif Raihana », « PRD-014 », « r.cherif@adventum.dz », « CHU Tizi »)
 * → les lignes candidates de l'ERP, notées, tranchées. Dix natures : personnes, sociétés du
 * groupe, fournisseurs, produits / dossiers, molécules, marques, hôpitaux, institutions,
 * partenaires, médecins. Chaque nature a sa table, sa clé, son lien ; les candidats se
 * rassemblent en trois passes bornées — identifiant exact, nom (préfixe / contenu), trigramme
 * (`pg_trgm` + `unaccent`, pour les fautes de frappe) — puis le scoreur pur tranche.
 *
 * ── CE QUE CETTE BRIQUE NE FAIT JAMAIS ─────────────────────────────────────────────────
 *
 * Elle n'ÉCRIT rien : pas de fusion, pas de création d'alias, pas de correction. Deux lignes qui
 * se ressemblent sont une QUESTION pour la personne (verdict AMBIGU) ou un constat du moteur de
 * qualité — jamais une fusion silencieuse. Un test statique vérifie l'absence de toute écriture.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { resolveProductMention } from "@/lib/products/resolve";
import {
  detecterIdentifiant, normaliserRequete, plierMolecules, scorerNom, trancher, TYPES_ENTITE,
  type Candidat, type Preuve, type Tranche, type TypeEntite,
} from "@/lib/fabric/entites-score";
import { sansBloquer } from "@/lib/journal";

export interface ResolutionEntite extends Tranche {
  requete: string;
  types: TypeEntite[];
  ms: number;
  /** Combien de lignes ont été notées — l'effort, pas le résultat. */
  examines: number;
}

const LIMITE_PAR_TABLE = 40;

const noter = (type: TypeEntite, id: string, libelle: string, requete: string, detail: string | null, href: string | null, bonus: { score: number; preuve: Preuve } | null = null): Candidat | null => {
  const s = scorerNom(requete, libelle);
  const score = Math.max(s.score, bonus?.score ?? 0);
  if (score <= 0) return null;
  const preuves: Preuve[] = [];
  if (bonus && bonus.score >= s.score) preuves.push(bonus.preuve);
  if (s.preuve && s.score >= (bonus?.score ?? 0)) preuves.push(s.preuve);
  return { type, id, libelle, detail, score, preuves, href };
};

/** Les candidats par trigramme — les fautes de frappe que « contains » ne voit pas. */
async function parTrigramme(table: string, colonne: string, requete: string, seuil = 0.32): Promise<{ id: string; v: string }[]> {
  const q = normaliserRequete(requete);
  if (q.length < 4) return [];
  try {
    return await prisma.$queryRawUnsafe<{ id: string; v: string }[]>(
      `SELECT id, "${colonne}" AS v FROM "${table}" WHERE "${colonne}" IS NOT NULL AND similarity(unaccent(lower("${colonne}")), unaccent($1)) > $2 ORDER BY similarity(unaccent(lower("${colonne}")), unaccent($1)) DESC LIMIT 12`,
      q, seuil,
    );
  } catch {
    return [];
  }
}

const jetonsRequete = (requete: string): string[] => normaliserRequete(requete).split(" ").filter((t) => t.length >= 3);
const contientUnJeton = (champ: string, requete: string) => {
  const j = jetonsRequete(requete);
  const q = normaliserRequete(requete);
  return { OR: [...(q ? [{ [champ]: { contains: q, mode: "insensitive" as const } }] : []), ...j.map((t) => ({ [champ]: { contains: t, mode: "insensitive" as const } }))] };
};

// ─────────────────────────────── Les natures ───────────────────────────────

async function personnes(requete: string, ident: ReturnType<typeof detecterIdentifiant>): Promise<Candidat[]> {
  const out: Candidat[] = [];
  if (ident?.kind === "email") {
    const [u, e] = await Promise.all([
      prisma.user.findFirst({ where: { email: { equals: ident.valeur, mode: "insensitive" } }, select: { id: true, name: true, title: true, department: { select: { name: true } } } }),
      prisma.employee.findFirst({ where: { email: { equals: ident.valeur, mode: "insensitive" } }, select: { id: true, fullName: true, position: true, userId: true, departmentRef: { select: { name: true } } } }),
    ]);
    if (u) out.push({ type: "PERSONNE", id: u.id, libelle: u.name, detail: [u.title, u.department?.name].filter(Boolean).join(" · ") || null, score: 1, preuves: ["email"], href: "/admin/access" });
    if (e && e.userId !== u?.id) out.push({ type: "PERSONNE", id: e.userId ?? e.id, libelle: e.fullName, detail: [e.position, e.departmentRef?.name].filter(Boolean).join(" · ") || null, score: 1, preuves: ["email"], href: `/rh/${e.id}` });
    return out;
  }
  const [users, employes, trgU, trgE] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, ...contientUnJeton("name", requete) }, select: { id: true, name: true, title: true, department: { select: { name: true } } }, take: LIMITE_PAR_TABLE }),
    prisma.employee.findMany({ where: { isActive: true, ...contientUnJeton("fullName", requete) }, select: { id: true, fullName: true, position: true, userId: true, departmentRef: { select: { name: true } } }, take: LIMITE_PAR_TABLE }),
    parTrigramme("User", "name", requete),
    parTrigramme("Employee", "fullName", requete),
  ]);
  const vusU = new Set(users.map((u) => u.id));
  const vusE = new Set(employes.map((e) => e.id));
  const plusU = trgU.filter((t) => !vusU.has(t.id)).length
    ? await prisma.user.findMany({ where: { id: { in: trgU.filter((t) => !vusU.has(t.id)).map((t) => t.id) }, isActive: true }, select: { id: true, name: true, title: true, department: { select: { name: true } } } })
    : [];
  const plusE = trgE.filter((t) => !vusE.has(t.id)).length
    ? await prisma.employee.findMany({ where: { id: { in: trgE.filter((t) => !vusE.has(t.id)).map((t) => t.id) }, isActive: true }, select: { id: true, fullName: true, position: true, userId: true, departmentRef: { select: { name: true } } } })
    : [];
  for (const u of [...users, ...plusU]) {
    const c = noter("PERSONNE", u.id, u.name, requete, [u.title, u.department?.name].filter(Boolean).join(" · ") || null, "/admin/access");
    if (c) out.push(c);
  }
  for (const e of [...employes, ...plusE]) {
    const c = noter("PERSONNE", e.userId ?? e.id, e.fullName, requete, [e.position, e.departmentRef?.name].filter(Boolean).join(" · ") || null, `/rh/${e.id}`);
    if (c) out.push(c);
  }
  return out;
}

async function fournisseurs(requete: string, ident: ReturnType<typeof detecterIdentifiant>): Promise<Candidat[]> {
  const out: Candidat[] = [];
  if (ident?.kind === "email" || ident?.kind === "domaine") {
    const rows = await prisma.supplier.findMany({ where: { contactEmail: { endsWith: ident.kind === "email" ? ident.valeur : `@${ident.valeur}`, mode: "insensitive" } }, select: { id: true, name: true, country: true, contactEmail: true }, take: 10 });
    for (const s of rows) out.push({ type: "FOURNISSEUR", id: s.id, libelle: s.name, detail: [s.country, s.contactEmail].filter(Boolean).join(" · ") || null, score: ident.kind === "email" ? 1 : 0.9, preuves: [ident.kind === "email" ? "email" : "domaine"], href: "/regulatory?onglet=fournisseurs" });
    if (out.length) return out;
  }
  const [rows, trg] = await Promise.all([
    prisma.supplier.findMany({ where: { active: true, ...contientUnJeton("name", requete) }, select: { id: true, name: true, country: true }, take: LIMITE_PAR_TABLE }),
    parTrigramme("Supplier", "name", requete),
  ]);
  const vus = new Set(rows.map((r) => r.id));
  const plus = trg.filter((t) => !vus.has(t.id)).length ? await prisma.supplier.findMany({ where: { id: { in: trg.filter((t) => !vus.has(t.id)).map((t) => t.id) }, active: true }, select: { id: true, name: true, country: true } }) : [];
  for (const s of [...rows, ...plus]) {
    const c = noter("FOURNISSEUR", s.id, s.name, requete, s.country, "/regulatory?onglet=fournisseurs");
    if (c) out.push(c);
  }
  return out;
}

async function societes(requete: string, ident: ReturnType<typeof detecterIdentifiant>): Promise<Candidat[]> {
  const rows = await prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true, shortName: true, legalIdentity: { select: { legalName: true, email: true, website: true } } }, take: 50 });
  const out: Candidat[] = [];
  for (const c of rows) {
    const noms = [c.name, c.shortName, c.legalIdentity?.legalName].filter((x): x is string => Boolean(x));
    let meilleur: Candidat | null = null;
    for (const n of noms) {
      const cand = noter("SOCIETE", c.id, c.name, requete, c.legalIdentity?.legalName && c.legalIdentity.legalName !== c.name ? c.legalIdentity.legalName : null, "/admin/entites");
      const s = scorerNom(requete, n);
      if (cand && s.score > (meilleur?.score ?? 0)) meilleur = { ...cand, score: s.score, preuves: s.preuve ? [s.preuve] : cand.preuves };
      else if (!cand && s.score > 0) meilleur = { type: "SOCIETE", id: c.id, libelle: c.name, detail: null, score: s.score, preuves: s.preuve ? [s.preuve] : [], href: "/admin/entites" };
    }
    if (ident?.kind === "domaine" || ident?.kind === "email") {
      const dom = ident.kind === "email" ? ident.valeur.split("@")[1] : ident.valeur;
      const site = (c.legalIdentity?.website ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
      const mail = (c.legalIdentity?.email ?? "").toLowerCase().split("@")[1] ?? "";
      if (dom && (site === dom || mail === dom)) meilleur = { type: "SOCIETE", id: c.id, libelle: c.name, detail: dom, score: 0.95, preuves: ["domaine"], href: "/admin/entites" };
    }
    if (meilleur) out.push(meilleur);
  }
  return out;
}

async function produits(requete: string, ident: ReturnType<typeof detecterIdentifiant>, types: readonly TypeEntite[]): Promise<Candidat[]> {
  const out: Candidat[] = [];
  const veutProduit = types.includes("PRODUIT"); const veutMolecule = types.includes("MOLECULE"); const veutMarque = types.includes("MARQUE");
  if (ident?.kind === "reference") {
    const rows = await prisma.regulatoryProduct.findMany({ where: { reference: { equals: ident.valeur, mode: "insensitive" } }, select: { id: true, reference: true, dci: true, brandName: true, dosage: true, dosageUnit: true, pharmaceuticalForm: true }, take: 5 });
    for (const p of rows) out.push({ type: "PRODUIT", id: p.id, libelle: `${p.reference} — ${p.brandName ?? p.dci}`, detail: [p.dci, p.dosage ? `${p.dosage}${p.dosageUnit ?? ""}` : null, p.pharmaceuticalForm].filter(Boolean).join(" · ") || null, score: 1, preuves: ["identifiant"], href: `/regulatory/${p.id}` });
    if (out.length) return out;
  }
  const q = normaliserRequete(requete);
  const [rows, trg, canon] = await Promise.all([
    prisma.regulatoryProduct.findMany({
      where: { OR: [...contientUnJeton("dci", requete).OR, ...contientUnJeton("brandName", requete).OR] },
      select: { id: true, reference: true, dci: true, brandName: true, dosage: true, dosageUnit: true, pharmaceuticalForm: true, packaging: true, status: true, partnerLab: true },
      take: LIMITE_PAR_TABLE,
    }),
    parTrigramme("RegulatoryProduct", "dci", requete, 0.4),
    // Le catalogue canonique et ses ALIAS (« Keytruda » → pembrolizumab) — la brique produits existante.
    veutProduit || veutMarque || veutMolecule ? resolveProductMention(requete).catch(sansBloquer("entites.produits.resolveProductMention", [])) : Promise.resolve([]),
  ]);
  const vus = new Set(rows.map((r) => r.id));
  const plus = trg.filter((t) => !vus.has(t.id)).length
    ? await prisma.regulatoryProduct.findMany({ where: { id: { in: trg.filter((t) => !vus.has(t.id)).map((t) => t.id) } }, select: { id: true, reference: true, dci: true, brandName: true, dosage: true, dosageUnit: true, pharmaceuticalForm: true, packaging: true, status: true, partnerLab: true } })
    : [];
  const qMol = plierMolecules(q);
  const moleculesVues = new Map<string, Candidat>();
  for (const p of [...rows, ...plus]) {
    const detail = [p.dosage ? `${p.dosage}${p.dosageUnit ?? ""}` : null, p.pharmaceuticalForm, p.packaging, p.status].filter(Boolean).join(" · ") || null;
    if (veutProduit) {
      const parDci = scorerNom(requete, p.dci);
      const parMarque = p.brandName ? scorerNom(requete, p.brandName) : { score: 0, preuve: null };
      const memeMolecules = qMol && plierMolecules(p.dci) === qMol ? { score: 0.97, preuve: "ordre" as Preuve } : null;
      const meilleur = [parDci, parMarque, memeMolecules].filter(Boolean).sort((a, b) => b!.score - a!.score)[0]!;
      if (meilleur.score > 0) out.push({ type: "PRODUIT", id: p.id, libelle: `${p.reference} — ${p.brandName ?? p.dci}`, detail: [p.dci, detail].filter(Boolean).join(" · "), score: meilleur.score, preuves: meilleur.preuve ? [meilleur.preuve] : [], href: `/regulatory/${p.id}` });
    }
    if (veutMolecule) {
      const cle = plierMolecules(p.dci);
      const s = qMol === cle ? { score: 1, preuve: "exact" as Preuve } : scorerNom(requete, p.dci);
      if (s.score > 0 && (moleculesVues.get(cle)?.score ?? 0) < s.score) moleculesVues.set(cle, { type: "MOLECULE", id: `dci:${cle}`, libelle: p.dci, detail: `dossier ${p.reference}`, score: s.score, preuves: s.preuve ? [s.preuve] : [], href: `/regulatory?q=${encodeURIComponent(p.dci)}` });
    }
    if (veutMarque && p.brandName) {
      const s = scorerNom(requete, p.brandName);
      if (s.score > 0) out.push({ type: "MARQUE", id: p.id, libelle: p.brandName, detail: `${p.dci} · ${p.reference}`, score: s.score, preuves: s.preuve ? [s.preuve] : [], href: `/regulatory/${p.id}` });
    }
  }
  out.push(...moleculesVues.values());
  // La brique produits classe déjà : référence (certaine), alias humain (certain), clé d'identité
  // complète (déterministe), rapprochement partiel (proposé). On traduit ses genres en preuves.
  const PREUVE_CANON: Record<string, { score: number; preuve: Preuve }> = {
    reference: { score: 1, preuve: "identifiant" }, alias: { score: 1, preuve: "alias" }, identity: { score: 0.97, preuve: "exact" }, partial: { score: 0.8, preuve: "jetons" },
  };
  for (const m of canon) {
    const p = m.product;
    const type: TypeEntite = veutProduit ? "PRODUIT" : veutMarque ? "MARQUE" : "MOLECULE";
    const pc = PREUVE_CANON[m.kind] ?? { score: 0.75, preuve: "jetons" as Preuve };
    out.push({ type, id: `product:${p.id}`, libelle: p.canonicalName, detail: [p.dci, p.dosage ? `${p.dosage}${p.dosageUnit ?? ""}` : null, p.form].filter(Boolean).join(" · ") || null, score: pc.score, preuves: [pc.preuve], href: `/explorateur-produits?q=${encodeURIComponent(p.canonicalName)}` });
  }
  return out;
}

async function institutions(requete: string, types: readonly TypeEntite[]): Promise<Candidat[]> {
  const [rows, trg] = await Promise.all([
    prisma.medicalInstitution.findMany({ where: { isActive: true, ...contientUnJeton("name", requete) }, select: { id: true, name: true, type: true, city: true, wilaya: true }, take: LIMITE_PAR_TABLE }),
    parTrigramme("MedicalInstitution", "name", requete),
  ]);
  const vus = new Set(rows.map((r) => r.id));
  const plus = trg.filter((t) => !vus.has(t.id)).length ? await prisma.medicalInstitution.findMany({ where: { id: { in: trg.filter((t) => !vus.has(t.id)).map((t) => t.id) }, isActive: true }, select: { id: true, name: true, type: true, city: true, wilaya: true } }) : [];
  const HOPITAUX = new Set(["CHU", "EPH", "EHS", "CLINIQUE_PRIVEE", "POLYCLINIQUE"]);
  const out: Candidat[] = [];
  for (const i of [...rows, ...plus]) {
    const type: TypeEntite = HOPITAUX.has(i.type) ? "HOPITAL" : "INSTITUTION";
    if (!types.includes(type) && !(types.includes("HOPITAL") && types.includes("INSTITUTION"))) { if (!types.includes(type)) continue; }
    const c = noter(type, i.id, i.name, requete, [i.type, i.city ?? i.wilaya].filter(Boolean).join(" · ") || null, `/medical?institution=${i.id}`);
    if (c) out.push(c);
  }
  return out;
}

async function medecins(requete: string, ident: ReturnType<typeof detecterIdentifiant>): Promise<Candidat[]> {
  if (ident?.kind === "email") {
    const rows = await prisma.medicalDoctor.findMany({ where: { email: { equals: ident.valeur, mode: "insensitive" } }, select: { id: true, name: true, specialty: true, institution: true }, take: 5 });
    return rows.map((d) => ({ type: "MEDECIN" as const, id: d.id, libelle: d.name, detail: [d.specialty, d.institution].filter(Boolean).join(" · ") || null, score: 1, preuves: ["email" as Preuve], href: `/medical?doctor=${d.id}` }));
  }
  const [rows, trg] = await Promise.all([
    prisma.medicalDoctor.findMany({ where: contientUnJeton("name", requete), select: { id: true, name: true, specialty: true, institution: true, city: true }, take: LIMITE_PAR_TABLE }),
    parTrigramme("MedicalDoctor", "name", requete),
  ]);
  const vus = new Set(rows.map((r) => r.id));
  const plus = trg.filter((t) => !vus.has(t.id)).length ? await prisma.medicalDoctor.findMany({ where: { id: { in: trg.filter((t) => !vus.has(t.id)).map((t) => t.id) } }, select: { id: true, name: true, specialty: true, institution: true, city: true } }) : [];
  const out: Candidat[] = [];
  for (const d of [...rows, ...plus]) {
    const c = noter("MEDECIN", d.id, d.name, requete, [d.specialty, d.institution ?? d.city].filter(Boolean).join(" · ") || null, `/medical?doctor=${d.id}`);
    if (c) out.push(c);
  }
  return out;
}

/** Les partenaires n'ont pas de table : ce sont les laboratoires et clients DISTINCTS portés par les dossiers, les opportunités et les marchés. */
async function partenaires(requete: string): Promise<Candidat[]> {
  const j = jetonsRequete(requete);
  if (!j.length) return [];
  const [labos, opps, marches] = await Promise.all([
    prisma.regulatoryProduct.findMany({ where: { partnerLab: { not: null }, OR: j.map((t) => ({ partnerLab: { contains: t, mode: "insensitive" as const } })) }, select: { partnerLab: true, countryOfOrigin: true }, take: 200 }),
    prisma.businessDevelopmentOpportunity.findMany({ where: { potentialSupplier: { not: null }, OR: j.map((t) => ({ potentialSupplier: { contains: t, mode: "insensitive" as const } })) }, select: { potentialSupplier: true, supplierCountry: true }, take: 100 }),
    prisma.pchTender.findMany({ where: { OR: j.map((t) => ({ client: { contains: t, mode: "insensitive" as const } })) }, select: { client: true }, take: 100 }),
  ]);
  const compte = new Map<string, { libelle: string; detail: string | null; n: number; source: string }>();
  const ajouter = (libelle: string | null, detail: string | null, source: string) => {
    if (!libelle) return;
    const k = normaliserRequete(libelle);
    const ex = compte.get(k);
    if (ex) ex.n += 1; else compte.set(k, { libelle, detail, n: 1, source });
  };
  for (const l of labos) ajouter(l.partnerLab, l.countryOfOrigin, "laboratoire partenaire");
  for (const o of opps) ajouter(o.potentialSupplier, o.supplierCountry, "fournisseur potentiel (BD)");
  for (const m of marches) ajouter(m.client, null, "client de marché PCH");
  const out: Candidat[] = [];
  for (const [k, v] of compte) {
    const c = noter("PARTENAIRE", `partenaire:${k}`, v.libelle, requete, [v.source, v.detail, `${v.n} ligne(s)`].filter(Boolean).join(" · "), null);
    if (c) out.push(c);
  }
  return out;
}

// ─────────────────────────────── L'entrée ───────────────────────────────

/**
 * RÉSOUDRE une mention. `types` restreint la recherche (défaut : toutes les natures) ; le verdict
 * tranche ; `question` dit quoi demander quand il y a ambiguïté. Jamais d'écriture.
 */
export async function resoudreEntite(requete: string, opts: { types?: readonly TypeEntite[]; limite?: number } = {}): Promise<ResolutionEntite> {
  const t0 = Date.now();
  const types = (opts.types && opts.types.length ? opts.types : TYPES_ENTITE) as TypeEntite[];
  const brut = (requete ?? "").trim().slice(0, 200);
  if (!normaliserRequete(brut) && !detecterIdentifiant(brut)) return { requete: brut, types, verdict: "INCONNU", retenu: null, candidats: [], question: null, ms: Date.now() - t0, examines: 0 };
  const ident = detecterIdentifiant(brut);
  const veut = (t: TypeEntite) => types.includes(t);
  const lots = await Promise.all([
    veut("PERSONNE") ? personnes(brut, ident) : [],
    veut("FOURNISSEUR") ? fournisseurs(brut, ident) : [],
    veut("SOCIETE") ? societes(brut, ident) : [],
    veut("PRODUIT") || veut("MOLECULE") || veut("MARQUE") ? produits(brut, ident, types) : [],
    veut("HOPITAL") || veut("INSTITUTION") ? institutions(brut, types) : [],
    veut("MEDECIN") ? medecins(brut, ident) : [],
    veut("PARTENAIRE") ? partenaires(brut) : [],
  ]);
  let tous = lots.flat();
  // Sans nature demandée, le PRODUIT absorbe sa marque (même ligne) et sa molécule (même DCI) :
  // « Keytruda » est un dossier, pas trois entités qui se disputent la certitude.
  if (!opts.types || !opts.types.length) {
    const produits = tous.filter((c) => c.type === "PRODUIT");
    const idsProduits = new Set(produits.map((c) => c.id));
    const dcis = new Set(produits.map((c) => plierMolecules(c.detail?.split(" · ")[0] ?? "")).filter(Boolean));
    tous = tous.filter((c) => !(c.type === "MARQUE" && idsProduits.has(c.id)) && !(c.type === "MOLECULE" && dcis.has(c.id.replace(/^dci:/, ""))));
  }
  const tranche = trancher(brut, tous, opts.limite ?? 6);
  return { requete: brut, types, ...tranche, ms: Date.now() - t0, examines: tous.length };
}

/** Plusieurs mentions d'un coup (celles d'une question) — bornées à quatre, en parallèle. */
export async function resoudreMentions(mentions: readonly string[], opts: { types?: readonly TypeEntite[] } = {}): Promise<ResolutionEntite[]> {
  const uniques = [...new Set(mentions.map((m) => m.trim()).filter((m) => m.length >= 2))].slice(0, 4);
  return Promise.all(uniques.map((m) => resoudreEntite(m, opts)));
}

/** Le bloc de contexte que le planificateur reçoit : ce qui est certain, ce qui est probable, ce qu'il faut DEMANDER. */
export function contexteEntitesResolues(resolutions: readonly ResolutionEntite[]): string | null {
  const lignes: string[] = [];
  for (const r of resolutions) {
    if (r.verdict === "CERTAIN" && r.retenu) lignes.push(`- « ${r.requete} » = ${r.retenu.libelle} (${r.retenu.type.toLowerCase()}, id ${r.retenu.id}${r.retenu.detail ? `, ${r.retenu.detail}` : ""}) — CERTAIN`);
    else if (r.verdict === "PROBABLE" && r.retenu) lignes.push(`- « ${r.requete} » ≈ ${r.retenu.libelle} (${r.retenu.type.toLowerCase()}, id ${r.retenu.id}${r.retenu.detail ? `, ${r.retenu.detail}` : ""}) — PROBABLE : le dire, et vérifier avant toute écriture`);
    else if (r.verdict === "AMBIGU") lignes.push(`- « ${r.requete} » est AMBIGU : ${r.question} — ne PAS choisir à sa place : poser la question avant d'agir`);
  }
  if (!lignes.length) return null;
  return `ENTITÉS RÉSOLUES PAR LE CODE (déterministe, sur la base — pas de mémoire) :\n${lignes.join("\n")}`;
}
