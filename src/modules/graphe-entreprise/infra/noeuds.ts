import { prisma } from "@/lib/prisma";
import { lireRef, type Provenance, type TypeNoeud } from "../domaine/noeuds";

/**
 * LES NŒUDS DÉCRITS (J9) — libellé, lien vers l'écran qui le montre, et la ligne d'où il vient (sa source). Lu par
 * lots, une requête par table ; un nœud dont la ligne a disparu n'est pas décrit (il ne sera pas rendu).
 */
export interface NoeudDecrit { ref: string; type: TypeNoeud; libelle: string; lien: string | null; source: Provenance }

export async function decrire(refs: readonly string[]): Promise<Map<string, NoeudDecrit>> {
  const ids: Record<string, string[]> = {};
  for (const r of refs) {
    const l = lireRef(r);
    if (!l) continue;
    const pre = l.id.slice(0, 2);
    const cle = l.type === "PERSONNE" || l.type === "ORGANISATION" || l.type === "DEMANDE_AD_PRO" || l.type === "CONGRES"
      ? (/^[a-z]:$/.test(pre) ? `${l.type}:${pre}` : l.type) : l.type;
    (ids[cle] ??= []).push(/^[a-z]:$/.test(pre) && cle !== l.type ? l.id.slice(2) : l.id);
  }
  const lire = <T>(cle: string, f: (liste: string[]) => Promise<T[]>) => (ids[cle]?.length ? f(ids[cle]!) : Promise.resolve([] as T[]));
  const [pers, users, emps, orgs, sups, cies, prods, dos, spo, evt, aut, cn, ci, pcs] = await Promise.all([
    lire("PERSONNE", (l) => prisma.personne.findMany({ where: { id: { in: l } }, select: { id: true, nom: true, prenoms: true, civilite: true } })),
    lire("PERSONNE:u:", (l) => prisma.user.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })),
    lire("PERSONNE:e:", (l) => prisma.employee.findMany({ where: { id: { in: l } }, select: { id: true, fullName: true } })),
    lire("ORGANISATION", (l) => prisma.organisation.findMany({ where: { id: { in: l } }, select: { id: true, raisonSociale: true, nomCourt: true } })),
    lire("ORGANISATION:f:", (l) => prisma.supplier.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })),
    lire("ORGANISATION:c:", (l) => prisma.company.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })),
    lire("PRODUIT", (l) => prisma.product.findMany({ where: { id: { in: l } }, select: { id: true, canonicalName: true, code: true } })),
    lire("DOSSIER", (l) => prisma.regulatoryProduct.findMany({ where: { id: { in: l } }, select: { id: true, reference: true, dci: true, brandName: true } })),
    lire("DEMANDE_AD_PRO:s:", (l) => prisma.sponsoringRequest.findMany({ where: { id: { in: l } }, select: { id: true, reference: true } })),
    lire("DEMANDE_AD_PRO:e:", (l) => prisma.event.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })),
    lire("DEMANDE_AD_PRO:a:", (l) => prisma.adProOtherRequest.findMany({ where: { id: { in: l } }, select: { id: true, reference: true, title: true } })),
    lire("CONGRES:n:", (l) => prisma.congressNational.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })),
    lire("CONGRES:i:", (l) => prisma.congressInternational.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })),
    lire("DOCUMENT", (l) => prisma.piece.findMany({ where: { id: { in: l } }, select: { id: true, nom: true } })),
  ]);
  const out = new Map<string, NoeudDecrit>();
  const poser = (type: TypeNoeud, id: string, libelle: string, lien: string | null, table: string, ligne: string) =>
    out.set(`${type}:${id}`, { ref: `${type}:${id}`, type, libelle, lien, source: { table, id: ligne } });
  for (const p of pers) poser("PERSONNE", p.id, [p.civilite, p.prenoms, p.nom].filter(Boolean).join(" "), `/personnes/${p.id}`, "Personne", p.id);
  for (const u of users) poser("PERSONNE", `u:${u.id}`, u.name, null, "User", u.id);
  for (const e of emps) poser("PERSONNE", `e:${e.id}`, e.fullName, null, "Employee", e.id);
  for (const o of orgs) poser("ORGANISATION", o.id, o.nomCourt && o.nomCourt !== o.raisonSociale ? `${o.raisonSociale} (${o.nomCourt})` : o.raisonSociale, `/organisations/${o.id}`, "Organisation", o.id);
  for (const s of sups) poser("ORGANISATION", `f:${s.id}`, s.name, null, "Supplier", s.id);
  for (const c of cies) poser("ORGANISATION", `c:${c.id}`, c.name, null, "Company", c.id);
  for (const p of prods) poser("PRODUIT", p.id, `${p.canonicalName} (${p.code})`, `/produits/${p.id}`, "Product", p.id);
  for (const d of dos) poser("DOSSIER", d.id, `${d.reference} — ${d.brandName ? `${d.brandName} (${d.dci})` : d.dci}`, `/regulatory/${d.id}`, "RegulatoryProduct", d.id);
  for (const s of spo) poser("DEMANDE_AD_PRO", `s:${s.id}`, `Sponsoring ${s.reference}`, `/sponsoring/${s.id}`, "SponsoringRequest", s.id);
  for (const e of evt) poser("DEMANDE_AD_PRO", `e:${e.id}`, `Événement « ${e.name} »`, `/events/${e.id}`, "Event", e.id);
  for (const a of aut) poser("DEMANDE_AD_PRO", `a:${a.id}`, `${a.reference} — ${a.title}`, `/ad-pro/autres/${a.id}`, "AdProOtherRequest", a.id);
  for (const c of cn) poser("CONGRES", `n:${c.id}`, c.name, `/congress-national/${c.id}`, "CongressNational", c.id);
  for (const c of ci) poser("CONGRES", `i:${c.id}`, c.name, `/congress-international/${c.id}`, "CongressInternational", c.id);
  for (const p of pcs) poser("DOCUMENT", p.id, p.nom, `/pieces/${p.id}`, "Piece", p.id);
  return out;
}
