import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { typeDe, type AreteDatee, type Provenance, type TypeNoeud } from "../domaine/noeuds";
import { Canoniseur, entitesDe, formesDe } from "./canon";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ARÊTES DATÉES QUI TOUCHENT UN LOT DE NŒUDS (J9, décision 0021) — lues là où elles sont déjà écrites.
 *
 *   EntityLink        les liens déclarés « Relier à… » (lie_a), datés de leur pose, avec qui les a posés ;
 *   PieceLien         une pièce et ce qu'elle concerne (son rôle en note) ;
 *   FaitConfirme      une pièce ATTESTE un fait d'un sujet, valide de `valideDu` à `valideAu` (jamais un fait sensible) ;
 *   EntityMention     un document du Drive MENTIONNE un dossier, une personne ;
 *   clés métier       affiliation (datée), emploi, dossier → produit / fournisseur / société / responsable / assistant,
 *                     demande ou congrès → organisation / demandeur / chef de produit / responsable.
 *
 * Une clé étrangère dit l'état ACTUEL : l'arête porte « valeur actuelle » en note, et sa date est celle de la ligne,
 * pas une période inventée. Rien n'est lu pour un type que le périmètre ferme (`types`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const jour = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const prov = (table: string, id: string, o: Omit<Provenance, "table" | "id"> = {}): Provenance => ({ table, id, ...o });
const ACTUELLE = "valeur actuelle de la fiche (non historisée)";

export async function aretesDe(refs: readonly string[], types: ReadonlySet<TypeNoeud>): Promise<AreteDatee[]> {
  const f = await formesDe(refs);
  const c = new Canoniseur(f);
  const k = (m: Map<string, string>) => [...m.keys()];
  const ouvert = (t: TypeNoeud) => types.has(t);
  const entites = entitesDe(f);
  const users = k(f.users); const orgs = k(f.organisations); const suppliers = k(f.suppliers); const companies = k(f.companies);
  const personnes = k(f.personnes); const employees = k(f.employees); const pieces = k(f.pieces); const nodes = k(f.driveNodes);
  const dossiers = k(f.dossiers); const produits = k(f.produits);
  const ou = <T>(conds: (T | null)[]): T[] => conds.filter((x): x is T => !!x);
  const si = <T>(n: number, v: T): T | null => (n ? v : null);

  const vide = Promise.resolve([] as never[]);
  const [liens, piecesLiees, faits, mentions, affiliations, emplois, dossiersLus, sponsorings, congresN, congresI, evenements, autres] = await Promise.all([
    entites.length
      ? prisma.entityLink.findMany({ where: { OR: entites.flatMap((e) => [{ fromType: e.type, fromId: { in: e.ids } }, { toType: e.type, toId: { in: e.ids } }]) }, take: 4000 })
      : vide,
    ouvert("DOCUMENT") ? prisma.pieceLien.findMany({
      where: { OR: ou<Prisma.PieceLienWhereInput>([
        si(pieces.length, { pieceId: { in: pieces } }), si(personnes.length, { sujetType: "PERSONNE", sujetId: { in: personnes } }),
        si(orgs.length, { sujetType: "ORGANISATION", sujetId: { in: orgs } }),
        ...entites.map((e) => ({ sujetType: "ENTITE" as const, entityType: e.type, sujetId: { in: e.ids } })),
      ]) },
      take: 4000,
    }) : vide,
    ouvert("DOCUMENT") ? prisma.faitConfirme.findMany({
      where: { pieceId: { not: null }, sensible: false, OR: ou<Prisma.FaitConfirmeWhereInput>([
        si(pieces.length, { pieceId: { in: pieces } }), si(personnes.length, { sujetType: "PERSONNE", sujetId: { in: personnes } }),
        si(orgs.length, { sujetType: "ORGANISATION", sujetId: { in: orgs } }), si(produits.length, { sujetType: "PRODUIT", sujetId: { in: produits } }),
      ]) },
      select: { id: true, sujetType: true, sujetId: true, attribut: true, pieceId: true, valideDu: true, valideAu: true, confirmeLe: true, confirmeParId: true },
      take: 4000,
    }) : vide,
    ouvert("DOCUMENT") && (nodes.length || dossiers.length || employees.length) ? prisma.entityMention.findMany({
      where: { OR: ou<Prisma.EntityMentionWhereInput>([
        si(nodes.length, { nodeId: { in: nodes } }), si(dossiers.length, { entityType: "PRODUIT", entityId: { in: dossiers } }),
        si(employees.length, { entityType: "PERSONNE", entityId: { in: employees } }),
      ]) },
      take: 4000,
    }) : vide,
    personnes.length || orgs.length ? prisma.affiliation.findMany({
      where: { OR: ou<Prisma.AffiliationWhereInput>([si(personnes.length, { personneId: { in: personnes } }), si(orgs.length, { organisationId: { in: orgs } })]) },
      select: { id: true, personneId: true, organisationId: true, depuis: true, jusquA: true, createdAt: true },
      take: 4000,
    }) : vide,
    employees.length || companies.length ? prisma.employee.findMany({
      where: { companyId: { not: null }, OR: ou<Prisma.EmployeeWhereInput>([si(employees.length, { id: { in: employees } }), si(companies.length, { companyId: { in: companies } })]) },
      select: { id: true, companyId: true, hireDate: true, isActive: true },
      take: 4000,
    }) : vide,
    ouvert("DOSSIER") && (dossiers.length || produits.length || suppliers.length || users.length || companies.length) ? prisma.regulatoryProduct.findMany({
      where: { OR: ou<Prisma.RegulatoryProductWhereInput>([
        si(dossiers.length, { id: { in: dossiers } }), si(produits.length, { productId: { in: produits } }),
        si(suppliers.length, { supplierId: { in: suppliers } }), si(companies.length, { companyId: { in: companies } }),
        si(users.length, { responsibleId: { in: users } }), si(users.length, { assistantId: { in: users } }),
      ]) },
      select: { id: true, productId: true, supplierId: true, companyId: true, responsibleId: true, assistantId: true, createdAt: true },
      take: 4000,
    }) : vide,
    ouvert("DEMANDE_AD_PRO") ? requeteParties(prisma.sponsoringRequest, k(f.sponsorings), orgs, users) : vide,
    ouvert("CONGRES") ? requeteParties(prisma.congressNational, k(f.congresN), orgs, users) : vide,
    ouvert("CONGRES") ? requeteParties(prisma.congressInternational, k(f.congresI), orgs, users) : vide,
    ouvert("DEMANDE_AD_PRO") && (f.evenements.size || users.length) ? prisma.event.findMany({
      where: { OR: ou<Prisma.EventWhereInput>([si(f.evenements.size, { id: { in: k(f.evenements) } }), si(users.length, { requesterId: { in: users } }), si(users.length, { responsibleId: { in: users } })]) },
      select: { id: true, requesterId: true, responsibleId: true, productManagerId: true, createdAt: true }, take: 4000,
    }) : vide,
    ouvert("DEMANDE_AD_PRO") && (f.autres.size || users.length) ? prisma.adProOtherRequest.findMany({
      where: { OR: ou<Prisma.AdProOtherRequestWhereInput>([si(f.autres.size, { id: { in: k(f.autres) } }), si(users.length, { requesterId: { in: users } })]) },
      select: { id: true, requesterId: true, createdAt: true }, take: 4000,
    }) : vide,
  ]);

  // Canoniser en UN lot toutes les lignes vues.
  for (const l of liens) { c.entite(l.fromType, l.fromId); c.entite(l.toType, l.toId); }
  for (const p of piecesLiees) if (p.sujetType === "ENTITE") c.entite(p.entityType, p.sujetId);
  for (const m of mentions) { c.node(m.nodeId); if (m.entityType === "PERSONNE") c.employee(m.entityId); }
  for (const e of emplois) { c.employee(e.id); c.company(e.companyId); }
  for (const d of dossiersLus) { c.supplier(d.supplierId); c.company(d.companyId); c.user(d.responsibleId); c.user(d.assistantId); }
  for (const x of [...sponsorings, ...congresN, ...congresI]) { c.user(x.requesterId); c.user(x.productManagerId); }
  for (const x of evenements) { c.user(x.requesterId); c.user(x.responsibleId); c.user(x.productManagerId); }
  for (const x of autres) c.user(x.requesterId);
  await c.resoudre();

  const out: AreteDatee[] = [];
  const poser = (de: string | null, a: string | null, relation: string, depuis: Date | null, jusqua: Date | null, source: Provenance, note: string | null = null) => {
    if (!de || !a || de === a) return;
    const td = typeDe(de); const ta = typeDe(a);
    if (!td || !ta || !types.has(td) || !types.has(ta)) return;
    out.push({ de, a, relation, depuis, jusqua, source, note });
  };
  const sujet = (t: string, id: string, entityType?: string | null) =>
    t === "PERSONNE" ? `PERSONNE:${id}` : t === "ORGANISATION" ? `ORGANISATION:${id}` : t === "PRODUIT" ? `PRODUIT:${id}` : c.pourEntite(entityType ?? null, id);

  for (const l of liens) poser(c.pourEntite(l.fromType, l.fromId), c.pourEntite(l.toType, l.toId), "lie_a", l.createdAt, null, prov("EntityLink", l.id, { par: l.createdById, le: jour(l.createdAt) }), l.note);
  for (const p of piecesLiees) poser(`DOCUMENT:${p.pieceId}`, sujet(p.sujetType, p.sujetId, p.entityType), "concerne", p.createdAt, null, prov("PieceLien", p.id, { piece: p.pieceId, par: p.creeParId, le: jour(p.createdAt) }), `rôle : ${p.role}`);
  for (const x of faits) poser(`DOCUMENT:${x.pieceId}`, sujet(x.sujetType, x.sujetId), "atteste", x.valideDu, x.valideAu, prov("FaitConfirme", x.id, { piece: x.pieceId, par: x.confirmeParId, le: jour(x.confirmeLe) }), x.attribut);
  for (const m of mentions) {
    const cible = m.entityType === "PRODUIT" ? `DOSSIER:${m.entityId}` : m.entityType === "PERSONNE" ? c.pourEmployee(m.entityId) : null;
    poser(c.pourNode(m.nodeId), cible, "mentionne", m.createdAt, null, prov("EntityMention", m.id, { le: jour(m.createdAt) }), `${m.occurrences} occurrence(s)`);
  }
  for (const x of affiliations) poser(`PERSONNE:${x.personneId}`, `ORGANISATION:${x.organisationId}`, "affilie_a", x.depuis, x.jusquA, prov("Affiliation", x.id, { le: jour(x.createdAt) }));
  for (const e of emplois) poser(c.pourEmployee(e.id), c.pourCompany(e.companyId), "employe_par", e.hireDate, null, prov("Employee", e.id), e.isActive ? null : "salarié inactif (date de sortie non tenue)");
  for (const d of dossiersLus) {
    const dos = `DOSSIER:${d.id}`;
    const p = prov("RegulatoryProduct", d.id, { le: jour(d.createdAt) });
    if (d.productId) poser(dos, `PRODUIT:${d.productId}`, "concerne", d.createdAt, null, p);
    poser(dos, c.pourSupplier(d.supplierId), "fourni_par", null, null, p, ACTUELLE);
    poser(dos, c.pourCompany(d.companyId), "porte_par", null, null, p, ACTUELLE);
    poser(c.pourUser(d.responsibleId), dos, "responsable_de", null, null, p, ACTUELLE);
    poser(c.pourUser(d.assistantId), dos, "assiste", null, null, p, ACTUELLE);
  }
  const parties = (lignes: Partie[], table: string, noeud: (id: string) => string, versOrg: string) => {
    for (const x of lignes) {
      const n = noeud(x.id);
      const p = prov(table, x.id, { le: jour(x.createdAt) });
      if (x.organisationId) poser(n, `ORGANISATION:${x.organisationId}`, versOrg, null, null, p, ACTUELLE);
      poser(c.pourUser(x.requesterId), n, "demande", x.createdAt, null, p);
      poser(c.pourUser(x.productManagerId), n, "instruit", null, null, p, ACTUELLE);
    }
  };
  parties(sponsorings, "SponsoringRequest", (id) => `DEMANDE_AD_PRO:s:${id}`, "beneficiaire");
  parties(congresN, "CongressNational", (id) => `CONGRES:n:${id}`, "organise_par");
  parties(congresI, "CongressInternational", (id) => `CONGRES:i:${id}`, "organise_par");
  for (const x of evenements) {
    const n = `DEMANDE_AD_PRO:e:${x.id}`;
    const p = prov("Event", x.id, { le: jour(x.createdAt) });
    poser(c.pourUser(x.requesterId), n, "demande", x.createdAt, null, p);
    poser(c.pourUser(x.responsibleId), n, "responsable_de", null, null, p, ACTUELLE);
    poser(c.pourUser(x.productManagerId), n, "instruit", null, null, p, ACTUELLE);
  }
  for (const x of autres) poser(c.pourUser(x.requesterId), `DEMANDE_AD_PRO:a:${x.id}`, "demande", x.createdAt, null, prov("AdProOtherRequest", x.id, { le: jour(x.createdAt) }));
  return out;
}

interface Partie { id: string; organisationId: string | null; requesterId: string | null; productManagerId: string | null; createdAt: Date }

/** Sponsoring et congrès ont la même forme : la demande, l'organisation, le demandeur, le chef de produit. */
async function requeteParties(
  table: { findMany: (a: { where: object; select: object; take: number }) => Promise<unknown[]> },
  ids: string[], orgs: string[], users: string[],
): Promise<Partie[]> {
  const ors: object[] = [];
  if (ids.length) ors.push({ id: { in: ids } });
  if (orgs.length) ors.push({ organisationId: { in: orgs } });
  if (users.length) ors.push({ requesterId: { in: users } }, { productManagerId: { in: users } });
  if (!ors.length) return [];
  return (await table.findMany({
    where: { OR: ors }, select: { id: true, organisationId: true, requesterId: true, productManagerId: true, createdAt: true }, take: 4000,
  })) as Partie[];
}
