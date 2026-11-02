import { prisma } from "@/lib/prisma";
import { foldOrg, initialsOf, orgTokens } from "@/lib/name-match";
import { ALIAS_WEIGHT, type AliasSource, type EntityKind } from "./contract";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PROJECTION — l'ERP se raconte lui-même au référentiel.
 *
 * ── CE QU'ELLE FAIT, ET CE QU'ELLE NE FAIT SURTOUT PAS ───────────────────────────────────
 *
 * Elle LIT les fiches que l'entreprise tient déjà — produits Regulatory, sociétés, fournisseurs,
 * comptes, fiches RH, annuaires — et en tire des entités et leurs graphies. Elle n'invente aucun
 * nom, ne devine aucun lien, n'écrit dans AUCUNE table métier. C'est une lecture qui produit un
 * index, rien de plus.
 *
 * C'est ici, et nulle part ailleurs, que « Keytruda » devient joignable par « pembrolizumab » :
 * les deux sont deux colonnes de la MÊME ligne `RegulatoryProduct`. La connaissance existait déjà
 * dans l'ERP ; il lui manquait seulement d'être indexée.
 *
 * ── POURQUOI ELLE EST IDEMPOTENTE PAR CONSTRUCTION ───────────────────────────────────────
 *
 * Chaque entité porte une CLÉ déterministe (`kind:refType:refId`). Rejouer la projection met à
 * jour ; elle ne double jamais. Sans cela, un balayage nocturne rejoué deux fois créerait deux
 * « Adventum Pharma » — et le résolveur, honnête, les présenterait comme une ambiguïté.
 *
 * ── UNE PERSONNE, PAS DEUX ───────────────────────────────────────────────────────────────
 *
 * Un employé qui a un compte ERP est LA MÊME personne que ce compte. La clé se replie donc sur le
 * compte quand `Employee.userId` existe : les deux fiches nourrissent une seule entité, et
 * chercher son prénom ne rend pas deux résultats identiques à départager.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une graphie à enregistrer. Le poids dit ce qu'elle vaut, la source dit d'où elle vient. */
interface AliasDraft {
  alias: string;
  source: AliasSource;
  weight: number;
}

interface EntityDraft {
  kind: EntityKind;
  refType: string | null;
  refId: string | null;
  canonicalName: string;
  companyId: string | null;
  aliases: AliasDraft[];
}

/**
 * LA CLÉ. Avec une fiche : elle désigne la fiche. Sans : elle désigne le nom replié — ce qui
 * fusionne « SD PHARMA » et « sd pharma » en une seule entité observée, ce qui est correct.
 */
export function entityKey(kind: EntityKind, refType: string | null, refId: string | null, nameFold: string): string {
  return refType && refId ? `${kind}:${refType}:${refId}` : `${kind}:name:${nameFold}`;
}

/** Nettoie une graphie candidate. Rend `null` quand elle n'identifie rien. */
function usableAlias(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (s.length < 2) return null;
  // Un alias fait uniquement de ponctuation ou de chiffres isolés n'identifie personne.
  if (!/[a-zA-ZÀ-ɏ؀-ۿ]/.test(s) && !/\d{3}/.test(s)) return null;
  return s;
}

/**
 * L'ACRONYME DÉRIVÉ. Calculé seulement à partir de TROIS mots significatifs : sur deux mots il
 * produit des sigles de deux lettres qui collident avec tout, et le gain ne paie pas le bruit.
 */
function derivedAcronym(name: string): string | null {
  const toks = orgTokens(name);
  if (toks.length < 3) return null;
  const acr = initialsOf(name);
  return acr.length >= 3 && acr.length <= 6 ? acr.toUpperCase() : null;
}

/** Écrit (ou met à jour) UNE entité et ses graphies. Ne lève pas : un échec isolé n'arrête rien. */
async function upsertEntity(d: EntityDraft): Promise<string | null> {
  const nameFold = foldOrg(d.canonicalName);
  if (!nameFold) return null;
  const key = entityKey(d.kind, d.refType, d.refId, nameFold);

  try {
    const entity = await prisma.knowledgeEntity.upsert({
      where: { key },
      create: {
        key, kind: d.kind, refType: d.refType, refId: d.refId,
        canonicalName: d.canonicalName, nameFold, companyId: d.companyId,
      },
      update: {
        // Le nom canonique SUIT la fiche : renommer une société dans l'ERP doit se voir ici.
        canonicalName: d.canonicalName, nameFold, companyId: d.companyId, isActive: true,
      },
      select: { id: true },
    });

    // Les graphies s'AJOUTENT sans jamais s'effacer : un alias retiré d'une fiche a pu être
    // employé pendant des années, et une recherche sur l'ancien nom doit continuer de marcher.
    // (Le ménage, s'il devient nécessaire, sera une décision explicite — pas un effet de bord.)
    const seen = new Set<string>();
    const rows: { entityId: string; alias: string; aliasFold: string; source: string; weight: number }[] = [];
    for (const a of d.aliases) {
      const clean = usableAlias(a.alias);
      if (!clean) continue;
      const aliasFold = foldOrg(clean);
      if (!aliasFold || seen.has(aliasFold)) continue;
      seen.add(aliasFold);
      rows.push({ entityId: entity.id, alias: clean, aliasFold, source: a.source, weight: a.weight });
    }
    if (rows.length) {
      await prisma.knowledgeAlias.createMany({ data: rows, skipDuplicates: true });
    }
    return entity.id;
  } catch (err) {
    console.error("[knowledge] upsertEntity failed", d.kind, d.canonicalName, err);
    return null;
  }
}

export interface ProjectionResult {
  entities: number;
  byKind: Partial<Record<EntityKind, number>>;
}

/**
 * PROJETTE TOUT L'ERP. Conçue pour tourner en fond, à froid, et être rejouée sans crainte.
 *
 * L'ordre suit l'autorité : ce que l'entreprise a saisi et vérifié d'abord, ce qu'on déduit
 * ensuite. Chaque source est isolée — si les produits échouent, les personnes passent quand même.
 */
export async function projectEntities(): Promise<ProjectionResult> {
  const out: ProjectionResult = { entities: 0, byKind: {} };
  const bump = (k: EntityKind) => { out.byKind[k] = (out.byKind[k] ?? 0) + 1; out.entities += 1; };

  // ── LES SOCIÉTÉS DU GROUPE ──────────────────────────────────────────────────────────────
  for (const c of await prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true, shortName: true } }).catch(sansBloquer("project.projectEntities.company", []))) {
    const aliases: AliasDraft[] = [{ alias: c.name, source: "erp:Company.name", weight: ALIAS_WEIGHT.canonical }];
    if (c.shortName) aliases.push({ alias: c.shortName, source: "erp:Company.shortName", weight: ALIAS_WEIGHT.short });
    const acr = derivedAcronym(c.name);
    if (acr) aliases.push({ alias: acr, source: "derived", weight: ALIAS_WEIGHT.derived });
    if (await upsertEntity({ kind: "company", refType: "Company", refId: c.id, canonicalName: c.name, companyId: c.id, aliases })) bump("company");
  }

  // ── LES FOURNISSEURS ────────────────────────────────────────────────────────────────────
  for (const s of await prisma.supplier.findMany({ where: { active: true }, select: { id: true, name: true } }).catch(sansBloquer("project.projectEntities.supplier", []))) {
    const aliases: AliasDraft[] = [{ alias: s.name, source: "erp:Supplier.name", weight: ALIAS_WEIGHT.canonical }];
    const acr = derivedAcronym(s.name);
    if (acr) aliases.push({ alias: acr, source: "derived", weight: ALIAS_WEIGHT.derived });
    if (await upsertEntity({ kind: "supplier", refType: "Supplier", refId: s.id, canonicalName: s.name, companyId: null, aliases })) bump("supplier");
  }

  // ── LES PRODUITS ET LEURS MOLÉCULES ─────────────────────────────────────────────────────
  //
  // LE CŒUR DE §10. Une ligne Regulatory porte à la fois la référence, le nom commercial et la
  // DCI. Les trois deviennent des graphies du MÊME dossier — c'est ainsi que « Keytruda » et
  // « pembrolizumab » mènent au même endroit, sans qu'aucun dictionnaire n'ait été écrit.
  const moleculeNames = new Map<string, string>(); // nom replié → graphie d'origine
  for (const p of await prisma.regulatoryProduct.findMany({
    select: { id: true, reference: true, dci: true, brandName: true, molecules: true, companyId: true },
  }).catch(sansBloquer("project.projectEntities.regulatoryProduct", []))) {
    const display = p.brandName?.trim() || p.dci;
    const aliases: AliasDraft[] = [
      { alias: p.reference, source: "erp:RegulatoryProduct.reference", weight: ALIAS_WEIGHT.reference },
      { alias: p.dci, source: "erp:RegulatoryProduct.dci", weight: ALIAS_WEIGHT.scientific },
    ];
    if (p.brandName) aliases.push({ alias: p.brandName, source: "erp:RegulatoryProduct.brandName", weight: ALIAS_WEIGHT.commercial });
    if (await upsertEntity({ kind: "product", refType: "RegulatoryProduct", refId: p.id, canonicalName: display, companyId: p.companyId, aliases })) bump("product");

    // Les molécules sont des entités à part entière : plusieurs dossiers partagent une DCI, et
    // « qu'avons-nous en pembrolizumab ? » est une question qui se pose vraiment.
    for (const m of moleculesOf(p.dci, p.molecules)) {
      const f = foldOrg(m);
      if (f && !moleculeNames.has(f)) moleculeNames.set(f, m);
    }
  }

  for (const [, name] of moleculeNames) {
    if (await upsertEntity({
      kind: "molecule", refType: null, refId: null, canonicalName: name, companyId: null,
      aliases: [{ alias: name, source: "erp:RegulatoryProduct.dci", weight: ALIAS_WEIGHT.scientific }],
    })) bump("molecule");
  }

  // ── LES PERSONNES ───────────────────────────────────────────────────────────────────────
  //
  // Le compte ERP fait autorité quand il existe ; la fiche RH s'y raccroche plutôt que de créer
  // un second exemplaire de la même personne.
  for (const u of await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true } }).catch(sansBloquer("project.projectEntities.user", []))) {
    const aliases: AliasDraft[] = [{ alias: u.name, source: "erp:User.name", weight: ALIAS_WEIGHT.canonical }];
    const local = u.email.split("@")[0];
    // « prenom.nom » est une graphie réelle : les gens s'écrivent ainsi dans les fils.
    if (local && local.length >= 3) aliases.push({ alias: local.replace(/[._-]+/g, " "), source: "erp:User.email", weight: ALIAS_WEIGHT.short });
    if (await upsertEntity({ kind: "person", refType: "User", refId: u.id, canonicalName: u.name, companyId: null, aliases })) bump("person");
  }

  for (const e of await prisma.employee.findMany({
    where: { isActive: true },
    select: { id: true, fullName: true, userId: true, companyId: true },
  }).catch(sansBloquer("project.projectEntities.employee", []))) {
    const refType = e.userId ? "User" : "Employee";
    const refId = e.userId ?? e.id;
    if (await upsertEntity({
      kind: "person", refType, refId, canonicalName: e.fullName, companyId: e.companyId,
      aliases: [{ alias: e.fullName, source: "erp:Employee.fullName", weight: ALIAS_WEIGHT.canonical }],
    })) bump("person");
  }

  // ── LES SURNOMS RÉELS ───────────────────────────────────────────────────────────────────
  //
  // `DirectoryEntry.aliases` est la seule source où quelqu'un a écrit, à la main, comment on
  // appelle vraiment une personne. C'est la plus précieuse : elle contient ce qu'aucun calcul ne
  // trouve (« AD », « M. le Directeur »). Elle enrichit l'entité canonique au lieu d'en créer une.
  for (const d of await prisma.directoryEntry.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true, aliases: true, userId: true, employeeId: true, contactId: true, companyId: true },
  }).catch(sansBloquer("project.projectEntities.directoryEntry", []))) {
    const refType = d.userId ? "User" : d.employeeId ? "Employee" : d.contactId ? "CompanyContact" : "DirectoryEntry";
    const refId = d.userId ?? d.employeeId ?? d.contactId ?? d.id;
    const kind: EntityKind = d.contactId ? "organization" : "person";
    const aliases: AliasDraft[] = [{ alias: d.displayName, source: "erp:DirectoryEntry.displayName", weight: ALIAS_WEIGHT.short }];
    for (const a of d.aliases) aliases.push({ alias: a, source: "user", weight: ALIAS_WEIGHT.short });
    if (await upsertEntity({ kind, refType, refId, canonicalName: d.displayName, companyId: d.companyId, aliases })) bump(kind);
  }

  // ── LES TIERS ───────────────────────────────────────────────────────────────────────────
  for (const c of await prisma.companyContact.findMany({
    where: { isActive: true },
    select: { id: true, name: true, contactName: true, companyId: true },
  }).catch(sansBloquer("project.projectEntities.companyContact", []))) {
    const aliases: AliasDraft[] = [{ alias: c.name, source: "erp:CompanyContact.name", weight: ALIAS_WEIGHT.canonical }];
    const acr = derivedAcronym(c.name);
    if (acr) aliases.push({ alias: acr, source: "derived", weight: ALIAS_WEIGHT.derived });
    if (await upsertEntity({ kind: "organization", refType: "CompanyContact", refId: c.id, canonicalName: c.name, companyId: c.companyId, aliases })) bump("organization");
  }

  console.info("[knowledge] entities projected", JSON.stringify(out));
  return out;
}

/**
 * LES MOLÉCULES D'UN DOSSIER. La DCI peut être une ASSOCIATION (« A + B »), et `molecules` porte
 * parfois la liste structurée. On accepte les deux, et on ne casse une association que sur les
 * séparateurs explicites — jamais sur l'espace, qui appartient aux noms (« acide clavulanique »).
 */
export function moleculesOf(dci: string, structured: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(structured)) {
    for (const m of structured) {
      if (typeof m === "string" && m.trim()) out.push(m.trim());
      else if (m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string") {
        out.push(String((m as { name: string }).name).trim());
      }
    }
  }
  if (!out.length) {
    for (const part of dci.split(/\s*[+/;]\s*/)) {
      const p = part.trim();
      if (p.length >= 3) out.push(p);
    }
  }
  return out.filter(Boolean);
}
