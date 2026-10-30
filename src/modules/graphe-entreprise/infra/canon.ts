import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lireRef, ref, type TypeNoeud } from "../domaine/noeuds";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DES LIGNES MÉTIER AUX NŒUDS CANONIQUES, ET RETOUR (J9) — par lots, une requête par table.
 *
 * Un compte (`User`), un salarié (`Employee`) désignent une `Personne` ; un fournisseur (`Supplier`) et une société du
 * groupe (`Company`) une `Organisation` ; un fichier du Drive (`DriveNode`) une `Piece`. Le graphe parle la langue des
 * fiches canoniques ; sans fiche, la ligne garde un nœud de repli préfixé (`u:`, `e:`, `f:`, `c:`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Formes {
  personnes: Map<string, string>; users: Map<string, string>; employees: Map<string, string>;
  organisations: Map<string, string>; suppliers: Map<string, string>; companies: Map<string, string>;
  produits: Map<string, string>; dossiers: Map<string, string>;
  sponsorings: Map<string, string>; evenements: Map<string, string>; autres: Map<string, string>;
  congresN: Map<string, string>; congresI: Map<string, string>;
  pieces: Map<string, string>; driveNodes: Map<string, string>;
}

const vide = (): Formes => ({
  personnes: new Map(), users: new Map(), employees: new Map(), organisations: new Map(), suppliers: new Map(), companies: new Map(),
  produits: new Map(), dossiers: new Map(), sponsorings: new Map(), evenements: new Map(), autres: new Map(),
  congresN: new Map(), congresI: new Map(), pieces: new Map(), driveNodes: new Map(),
});

/** Les identifiants BRUTS (par table) par lesquels un lot de nœuds apparaît dans les tables métier. */
export async function formesDe(refs: readonly string[]): Promise<Formes> {
  const f = vide();
  for (const r of refs) {
    const l = lireRef(r);
    if (!l) continue;
    const { type, id } = l;
    const pre = id.slice(0, 2);
    const nu = id.slice(2);
    if (type === "PERSONNE") { if (pre === "u:") f.users.set(nu, r); else if (pre === "e:") f.employees.set(nu, r); else f.personnes.set(id, r); }
    else if (type === "ORGANISATION") { if (pre === "f:") f.suppliers.set(nu, r); else if (pre === "c:") f.companies.set(nu, r); else f.organisations.set(id, r); }
    else if (type === "PRODUIT") f.produits.set(id, r);
    else if (type === "DOSSIER") f.dossiers.set(id, r);
    else if (type === "DEMANDE_AD_PRO") ({ "s:": f.sponsorings, "e:": f.evenements, "a:": f.autres } as Record<string, Map<string, string>>)[pre]?.set(nu, r);
    else if (type === "CONGRES") ({ "n:": f.congresN, "i:": f.congresI } as Record<string, Map<string, string>>)[pre]?.set(nu, r);
    else if (type === "DOCUMENT") f.pieces.set(id, r);
  }
  const personnes = [...f.personnes.keys()];
  const orgs = [...f.organisations.keys()];
  const pieces = [...f.pieces.keys()];
  const [users, employees, suppliers, companies, nodes] = await Promise.all([
    personnes.length ? prisma.user.findMany({ where: { personneId: { in: personnes } }, select: { id: true, personneId: true } }) : [],
    personnes.length ? prisma.employee.findMany({ where: { personneId: { in: personnes } }, select: { id: true, personneId: true } }) : [],
    orgs.length ? prisma.supplier.findMany({ where: { organisationId: { in: orgs } }, select: { id: true, organisationId: true } }) : [],
    orgs.length ? prisma.company.findMany({ where: { organisationId: { in: orgs } }, select: { id: true, organisationId: true } }) : [],
    pieces.length ? prisma.driveNode.findMany({ where: { pieceId: { in: pieces }, isTrashed: false }, select: { id: true, pieceId: true } }) : [],
  ]);
  for (const u of users) f.users.set(u.id, f.personnes.get(u.personneId!)!);
  for (const e of employees) f.employees.set(e.id, f.personnes.get(e.personneId!)!);
  for (const s of suppliers) f.suppliers.set(s.id, f.organisations.get(s.organisationId!)!);
  for (const c of companies) f.companies.set(c.id, f.organisations.get(c.organisationId!)!);
  for (const n of nodes) f.driveNodes.set(n.id, f.pieces.get(n.pieceId!)!);
  return f;
}

/** Les paires (type d'entité, identifiants) sous lesquelles ces formes apparaissent dans `EntityLink` / `PieceLien`. */
export function entitesDe(f: Formes): { type: EntityType; ids: string[] }[] {
  const l: [EntityType, Map<string, string>][] = [
    ["REGULATORY_PRODUCT", f.dossiers], ["PRODUCT", f.produits], ["SPONSORING", f.sponsorings], ["EVENT", f.evenements],
    ["AD_PRO_OTHER", f.autres], ["CONGRESS_NATIONAL", f.congresN], ["CONGRESS_INTERNATIONAL", f.congresI],
    ["SUPPLIER", f.suppliers], ["COMPANY", f.companies], ["EMPLOYEE", f.employees], ["DRIVE_NODE", f.driveNodes],
  ];
  return l.filter(([, m]) => m.size).map(([type, m]) => ({ type, ids: [...m.keys()] }));
}

/** LE CANONISEUR : collecte les lignes vues, les résout en un lot, puis rend le nœud de chacune. */
export class Canoniseur {
  private attente = { users: new Set<string>(), employees: new Set<string>(), suppliers: new Set<string>(), companies: new Set<string>(), nodes: new Set<string>() };
  private resolu = { users: new Map<string, string>(), employees: new Map<string, string>(), suppliers: new Map<string, string>(), companies: new Map<string, string>(), nodes: new Map<string, string | null>() };

  constructor(connu?: Formes) {
    if (!connu) return;
    for (const [k, v] of connu.users) this.resolu.users.set(k, v);
    for (const [k, v] of connu.employees) this.resolu.employees.set(k, v);
    for (const [k, v] of connu.suppliers) this.resolu.suppliers.set(k, v);
    for (const [k, v] of connu.companies) this.resolu.companies.set(k, v);
    for (const [k, v] of connu.driveNodes) this.resolu.nodes.set(k, v);
  }

  user(id: string | null | undefined) { if (id && !this.resolu.users.has(id)) this.attente.users.add(id); }
  employee(id: string | null | undefined) { if (id && !this.resolu.employees.has(id)) this.attente.employees.add(id); }
  supplier(id: string | null | undefined) { if (id && !this.resolu.suppliers.has(id)) this.attente.suppliers.add(id); }
  company(id: string | null | undefined) { if (id && !this.resolu.companies.has(id)) this.attente.companies.add(id); }
  node(id: string | null | undefined) { if (id && !this.resolu.nodes.has(id)) this.attente.nodes.add(id); }
  entite(type: EntityType | string | null, id: string) {
    if (type === "SUPPLIER") this.supplier(id); else if (type === "COMPANY") this.company(id);
    else if (type === "EMPLOYEE") this.employee(id); else if (type === "DRIVE_NODE") this.node(id);
  }

  async resoudre(): Promise<void> {
    const a = this.attente;
    const [users, employees, suppliers, companies, nodes] = await Promise.all([
      a.users.size ? prisma.user.findMany({ where: { id: { in: [...a.users] } }, select: { id: true, personneId: true } }) : [],
      a.employees.size ? prisma.employee.findMany({ where: { id: { in: [...a.employees] } }, select: { id: true, personneId: true } }) : [],
      a.suppliers.size ? prisma.supplier.findMany({ where: { id: { in: [...a.suppliers] } }, select: { id: true, organisationId: true } }) : [],
      a.companies.size ? prisma.company.findMany({ where: { id: { in: [...a.companies] } }, select: { id: true, organisationId: true } }) : [],
      a.nodes.size ? prisma.driveNode.findMany({ where: { id: { in: [...a.nodes] }, isTrashed: false }, select: { id: true, pieceId: true } }) : [],
    ]);
    for (const u of users) this.resolu.users.set(u.id, ref("PERSONNE", u.personneId ?? `u:${u.id}`));
    for (const e of employees) this.resolu.employees.set(e.id, ref("PERSONNE", e.personneId ?? `e:${e.id}`));
    for (const s of suppliers) this.resolu.suppliers.set(s.id, ref("ORGANISATION", s.organisationId ?? `f:${s.id}`));
    for (const c of companies) this.resolu.companies.set(c.id, ref("ORGANISATION", c.organisationId ?? `c:${c.id}`));
    for (const n of nodes) this.resolu.nodes.set(n.id, n.pieceId ? ref("DOCUMENT", n.pieceId) : null);
    this.attente = { users: new Set(), employees: new Set(), suppliers: new Set(), companies: new Set(), nodes: new Set() };
  }

  pourUser(id: string | null | undefined) { return id ? this.resolu.users.get(id) ?? null : null; }
  pourEmployee(id: string | null | undefined) { return id ? this.resolu.employees.get(id) ?? null : null; }
  pourSupplier(id: string | null | undefined) { return id ? this.resolu.suppliers.get(id) ?? null : null; }
  pourCompany(id: string | null | undefined) { return id ? this.resolu.companies.get(id) ?? null : null; }
  pourNode(id: string | null | undefined) { return id ? this.resolu.nodes.get(id) ?? null : null; }

  /** Le nœud d'une entité d'`EntityLink` / `PieceLien` ; `null` hors du graphe (une tâche, une paie…). */
  pourEntite(type: EntityType | string | null, id: string): string | null {
    const direct: Partial<Record<string, [TypeNoeud, string]>> = {
      REGULATORY_PRODUCT: ["DOSSIER", ""], PRODUCT: ["PRODUIT", ""], SPONSORING: ["DEMANDE_AD_PRO", "s:"], EVENT: ["DEMANDE_AD_PRO", "e:"],
      AD_PRO_OTHER: ["DEMANDE_AD_PRO", "a:"], CONGRESS_NATIONAL: ["CONGRES", "n:"], CONGRESS_INTERNATIONAL: ["CONGRES", "i:"],
    };
    const d = type ? direct[type] : undefined;
    if (d) return ref(d[0], `${d[1]}${id}`);
    if (type === "SUPPLIER") return this.pourSupplier(id);
    if (type === "COMPANY") return this.pourCompany(id);
    if (type === "EMPLOYEE") return this.pourEmployee(id);
    if (type === "DRIVE_NODE") return this.pourNode(id);
    return null;
  }
}
