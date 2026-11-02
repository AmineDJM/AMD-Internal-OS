import { prisma } from "@/lib/prisma";
import { scopeCongressIntl, scopeCongressNational, scopePromoMaterial, scopeSponsoring } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import type { CurrentUser } from "@/lib/session";
import { replier } from "./annuaire-medical";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TROUVER UNE DEMANDE AD & PRO — parmi celles que la personne VOIT, et aucune autre.
 *
 * Le résolveur d'Adam (`resolveMissionParent`) cherche dans TOUTES les demandes, et sa réponse
 * « plusieurs cibles possibles » NOMME des demandes que la personne n'a pas le droit de voir —
 * sans effet pour Adam (Super Admin seul), inacceptable pour l'Assistant IA : l'information
 * n'entre jamais dans le contexte (limite L1). Ici, chaque nature passe par la portée de son
 * module (`scope*`) ou, à défaut, par le droit de la fiche (`canAccessEntity`).
 *
 * Une désignation ambiguë revient avec ses candidats — VISIBLES — et l'agent demande laquelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureDemande = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "PROMO_MATERIAL" | "AD_PRO_OTHER";

export interface DemandeVisible {
  nature: NatureDemande;
  id: string;
  libelle: string;
  lien: string;
}

const LIBELLE_NATURE: Record<NatureDemande, string> = {
  SPONSORING: "sponsoring", CONGRESS_NATIONAL: "prise en charge nationale", CONGRESS_INTERNATIONAL: "prise en charge internationale",
  EVENT: "événement", PROMO_MATERIAL: "matériel promotionnel", AD_PRO_OTHER: "demande autre",
};

/** « sponsoring », « congrès national »… → la nature ; vide → toutes. */
export function naturesVoulues(brut: string): NatureDemande[] {
  const k = replier(brut);
  if (!k) return ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "PROMO_MATERIAL", "AD_PRO_OTHER"];
  const out: NatureDemande[] = [];
  if (/sponsor/.test(k)) out.push("SPONSORING");
  if (/inter/.test(k)) out.push("CONGRESS_INTERNATIONAL");
  if (/nation/.test(k) || (/congr|prise en charge/.test(k) && !/inter/.test(k))) out.push("CONGRESS_NATIONAL");
  if (/congr|prise en charge/.test(k) && !/nation|inter/.test(k)) out.push("CONGRESS_INTERNATIONAL");
  if (/[ée]v[ée]nement|event/.test(k)) out.push("EVENT");
  if (/promo|mat[ée]riel/.test(k)) out.push("PROMO_MATERIAL");
  if (/autre/.test(k)) out.push("AD_PRO_OTHER");
  return out.length ? [...new Set(out)] : naturesVoulues("");
}

export async function demandesVisibles(user: CurrentUser, q: string, natures: NatureDemande[], limite = 6): Promise<DemandeVisible[]> {
  const t = q.trim();
  if (t.length < 2) return [];
  const contient = { contains: t, mode: "insensitive" as const };
  const egal = { equals: t, mode: "insensitive" as const };
  const out: DemandeVisible[] = [];
  if (natures.includes("SPONSORING")) {
    for (const s of await prisma.sponsoringRequest.findMany({ where: { AND: [scopeSponsoring(user), { OR: [{ reference: egal }, { institution: contient }] }] }, select: { id: true, reference: true, institution: true }, take: limite })) {
      out.push({ nature: "SPONSORING", id: s.id, libelle: `${s.reference} — ${s.institution}`, lien: `/sponsoring/${s.id}` });
    }
  }
  if (natures.includes("CONGRESS_NATIONAL")) {
    for (const c of await prisma.congressNational.findMany({ where: { AND: [scopeCongressNational(user), { name: contient }] }, select: { id: true, name: true }, take: limite })) {
      out.push({ nature: "CONGRESS_NATIONAL", id: c.id, libelle: c.name, lien: `/congress-national/${c.id}` });
    }
  }
  if (natures.includes("CONGRESS_INTERNATIONAL")) {
    for (const c of await prisma.congressInternational.findMany({ where: { AND: [scopeCongressIntl(user), { name: contient }] }, select: { id: true, name: true }, take: limite })) {
      out.push({ nature: "CONGRESS_INTERNATIONAL", id: c.id, libelle: c.name, lien: `/congress-international/${c.id}` });
    }
  }
  if (natures.includes("PROMO_MATERIAL")) {
    for (const p of await prisma.promoMaterial.findMany({ where: { AND: [scopePromoMaterial(user), { OR: [{ reference: egal }, { title: contient }] }] }, select: { id: true, reference: true, title: true }, take: limite })) {
      out.push({ nature: "PROMO_MATERIAL", id: p.id, libelle: `${p.reference} — ${p.title}`, lien: `/promo-material/${p.id}` });
    }
  }
  // Pas de portée de module pour ces deux natures : le droit de la FICHE, ligne par ligne.
  if (natures.includes("EVENT")) {
    for (const e of await prisma.event.findMany({ where: { name: contient }, select: { id: true, name: true }, take: limite * 3 })) {
      if (await canAccessEntity(user, "EVENT", e.id, "VIEW")) out.push({ nature: "EVENT", id: e.id, libelle: e.name, lien: `/events/${e.id}` });
    }
  }
  if (natures.includes("AD_PRO_OTHER")) {
    for (const a of await prisma.adProOtherRequest.findMany({ where: { OR: [{ reference: egal }, { title: contient }] }, select: { id: true, reference: true, title: true }, take: limite * 3 })) {
      if (await canAccessEntity(user, "AD_PRO_OTHER", a.id, "VIEW")) out.push({ nature: "AD_PRO_OTHER", id: a.id, libelle: `${a.reference} — ${a.title}`, lien: `/ad-pro/autres/${a.id}` });
    }
  }
  return out.slice(0, limite * 2);
}

/** K6 : la personne VOIT-elle cette fiche de l'ERP ? (le droit de la fiche, celui de l'écran). */
export const ficheVisible = (user: CurrentUser, type: string, id: string): Promise<boolean> =>
  canAccessEntity(user, type as Parameters<typeof canAccessEntity>[1], id, "VIEW");

const NATURES = new Set<string>(["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "PROMO_MATERIAL", "AD_PRO_OTHER"]);
export const estNatureDemande = (t: string): t is NatureDemande => NATURES.has(t);

/**
 * K6 (décision 0036) : UNE demande désignée par sa nature et son IDENTIFIANT (l'attente de pièces la garde ainsi) — si la
 * personne la voit encore (même portée que la recherche), avec son libellé et son lien ; `null` sinon.
 */
export async function demandeParId(user: CurrentUser, nature: NatureDemande, id: string): Promise<DemandeVisible | null> {
  if (!id.trim()) return null;
  const parId = { id: id.trim() };
  switch (nature) {
    case "SPONSORING": {
      const s = await prisma.sponsoringRequest.findFirst({ where: { AND: [scopeSponsoring(user), parId] }, select: { id: true, reference: true, institution: true } });
      return s ? { nature, id: s.id, libelle: `${s.reference} — ${s.institution}`, lien: `/sponsoring/${s.id}` } : null;
    }
    case "CONGRESS_NATIONAL": {
      const c = await prisma.congressNational.findFirst({ where: { AND: [scopeCongressNational(user), parId] }, select: { id: true, name: true } });
      return c ? { nature, id: c.id, libelle: c.name, lien: `/congress-national/${c.id}` } : null;
    }
    case "CONGRESS_INTERNATIONAL": {
      const c = await prisma.congressInternational.findFirst({ where: { AND: [scopeCongressIntl(user), parId] }, select: { id: true, name: true } });
      return c ? { nature, id: c.id, libelle: c.name, lien: `/congress-international/${c.id}` } : null;
    }
    case "PROMO_MATERIAL": {
      const p = await prisma.promoMaterial.findFirst({ where: { AND: [scopePromoMaterial(user), parId] }, select: { id: true, reference: true, title: true } });
      return p ? { nature, id: p.id, libelle: `${p.reference} — ${p.title}`, lien: `/promo-material/${p.id}` } : null;
    }
    case "EVENT": {
      const e = await prisma.event.findUnique({ where: parId, select: { id: true, name: true } });
      return e && (await canAccessEntity(user, "EVENT", e.id, "VIEW")) ? { nature, id: e.id, libelle: e.name, lien: `/events/${e.id}` } : null;
    }
    case "AD_PRO_OTHER": {
      const a = await prisma.adProOtherRequest.findUnique({ where: parId, select: { id: true, reference: true, title: true } });
      return a && (await canAccessEntity(user, "AD_PRO_OTHER", a.id, "VIEW")) ? { nature, id: a.id, libelle: `${a.reference} — ${a.title}`, lien: `/ad-pro/autres/${a.id}` } : null;
    }
  }
}

const MOTS_VIDES = new Set(["sponsoring", "congres", "demande", "prise", "charge", "pour", "evenement", "national", "nationale", "international", "internationale", "dans", "fiche", "fiches", "avec"]);

/** UNE demande, ou ce qu'il faut demander : jamais un choix silencieux, jamais un nom invisible. */
export async function trouverDemande(user: CurrentUser, q: string, nature: string): Promise<DemandeVisible | { manque: string }> {
  if (!q.trim()) return { manque: "la demande visée (sa référence ou son nom)" };
  const natures = naturesVoulues(nature);
  let hits = await demandesVisibles(user, q, natures);
  // « le sponsoring SAHGE d'Oran » ne se trouve pas d'un bloc : MOT À MOT (lot T3), parmi les mêmes demandes visibles —
  // celles qui portent TOUS les mots significatifs, sinon celles qui en portent le plus (une seule, ou la question).
  if (!hits.length) {
    const mots = [...new Set(replier(q).split(/\s+/).filter((m) => m.length >= 4 && !MOTS_VIDES.has(m)))].slice(0, 5);
    const pool = new Map<string, DemandeVisible>();
    for (const m of mots) for (const h of await demandesVisibles(user, m, natures)) pool.set(`${h.nature}:${h.id}`, h);
    const notes = [...pool.values()].map((h) => ({ h, n: mots.filter((m) => replier(h.libelle).includes(m)).length }));
    const meilleur = Math.max(0, ...notes.map((x) => x.n));
    hits = meilleur > 0 ? notes.filter((x) => x.n === meilleur).map((x) => x.h) : [];
  }
  const exacts = hits.filter((h) => replier(h.libelle).startsWith(replier(q)) || replier(h.libelle).includes(` ${replier(q)}`) || replier(h.libelle) === replier(q));
  if (hits.length === 1) return hits[0]!;
  if (exacts.length === 1) return exacts[0]!;
  if (hits.length === 0) return { manque: `« ${q} » : aucune demande que vous pouvez voir ne correspond — une autre référence ou un autre nom` };
  return { manque: `laquelle : ${hits.slice(0, 6).map((h) => `${h.libelle} (${LIBELLE_NATURE[h.nature]})`).join(" ; ")}` };
}
