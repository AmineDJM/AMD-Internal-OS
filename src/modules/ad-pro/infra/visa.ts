import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { toNumber } from "@/lib/utils";
import { porteDgRequise } from "@/lib/seuils/ad-pro";
import { type EtatVisa, visaAutoriseAAvancer, motifBlocageVisa } from "../domaine/centre";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VISA DU CENTRE — poser la porte, la lire, la lever.
 *
 * Les cinq natures qui portent une étape de circuit (`dg`, `REVIEW_DG`) n'ont RIEN à faire ici :
 * leur porte est déjà leur état. Ce module ne sert que le consulting et les « autres demandes »,
 * qui n'en avaient aucune — mesuré sur leurs machines à états, rien n'y consultait le seuil.
 *
 * Il n'emporte AUCUNE permission : `siegeAuCentreAdPro` reste chez ses appelants. Y glisser une
 * garde en ferait une seconde vérité en retard sur `centre.ts` (§118.119a).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le seuil en vigueur. Une lecture qui échoue rend `null` — donc AUCUNE porte, jamais un blocage. */
export async function seuilAdProEnVigueur(): Promise<number | null> {
  const s = await getAppSettings().catch(sansBloquer("visa.seuilAdProEnVigueur.getAppSettings", null));
  const v = s?.adProDgThreshold;
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * POSER LA PORTE SI LE MONTANT L'EXIGE — appelée à la SOUMISSION, pas à la création.
 *
 * Pourquoi à la soumission : un brouillon change de montant jusqu'à la dernière minute, et poser
 * la porte sur un chiffre provisoire ferait arbitrer le centre sur une demande que son auteur
 * n'a pas encore envoyée. C'est le moment où le demandeur DIT « voilà ma demande » qui compte.
 *
 * IDEMPOTENTE par la clé d'unicité `(entityType, entityId)` : repasser par la porte retrouve le
 * visa existant au lieu d'en créer un second. Et elle ne RÉOUVRE jamais un visa déjà tranché —
 * une resoumission après refus ne doit pas effacer la décision du centre ; c'est au centre de la
 * revoir. Rendre `APPROVED` sur un visa refusé serait le faux succès le plus coûteux du lot.
 *
 * Le seuil est FIGÉ dans le visa : sans lui, baisser le seuil rendrait la décision passée
 * inexplicable (§118.41).
 */
export async function poserVisaAdPro(
  entityType: EntityType,
  entityId: string,
  montant: number | null,
): Promise<EtatVisa | null> {
  const existant = await lireVisaAdPro(entityType, entityId);
  if (existant != null) return existant;

  const seuil = await seuilAdProEnVigueur();
  if (!porteDgRequise(montant, seuil)) return null;

  await prisma.adProGateVisa.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    create: {
      entityType, entityId, status: "PENDING",
      threshold: seuil as number,
      amount: montant != null && montant > 0 ? montant : null,
    },
    // Course entre deux soumissions simultanées : le second passage ne touche à rien.
    //
    // DEUX GARDES POUR UNE SEULE PROPRIÉTÉ, et c'est voulu — avec sa raison MESURÉE (§118.116).
    // Le retour anticipé ci-dessus évite une lecture de réglage inutile et rend l'état VRAI ;
    // ce `update: {}` protège l'entrelacement où deux soumissions se croisent avant que l'une
    // ait vu la ligne de l'autre. Le banc de sabotage l'a montré : retirée SEULE, chacune laisse
    // l'autre debout et le banc reste vert ; retirées ENSEMBLE, le banc tombe. Ce n'est donc pas
    // une redondance adossée à une affirmation fausse — c'est deux causes distinctes, chacune
    // avec son cas.
    update: {},
  });
  return "PENDING";
}

/**
 * RETIRER UNE PORTE QUI ATTEND — jamais une décision prise.
 *
 * Quand la demande quitte le périmètre du centre (un contrat de consulting transféré aux RH,
 * §118.150), ce qui attendait n'a plus d'objet : le centre de la promotion n'arbitre pas un
 * contrat qui ne relève plus d'elle. Une décision déjà RENDUE, elle, reste — c'est de l'histoire,
 * pas une attente. Rend le nombre de portes retirées, pour que l'appelant le DISE.
 */
export async function retirerVisaEnAttente(entityType: EntityType, entityId: string): Promise<number> {
  const r = await prisma.adProGateVisa.deleteMany({ where: { entityType, entityId, status: "PENDING" } });
  return r.count;
}

/**
 * CE QUE LA PORTE DEVIENT QUAND LE MONTANT CHANGE AVANT LA DÉCISION (audit 360°, lot C4a).
 *
 * Un contrat de consulting ou une « autre demande » se corrige désormais (édition, renvoi puis
 * resoumission) : le montant que le centre arbitre peut donc bouger APRÈS la pose de la porte. La
 * porte suit le montant, jamais l'inverse — sinon on corrigerait sous le seuil pour échapper au
 * centre, ou au-dessus d'un accord sans qu'il l'ait vu :
 *   • aucune porte, le montant l'exige désormais → elle s'OUVRE ;
 *   • en attente, le montant ne l'exige plus → elle est RETIRÉE ; sinon son montant se met à jour ;
 *   • autorisée, le montant MONTE au-delà de ce qu'elle couvrait → elle se ROUVRE : un accord ne
 *     couvre pas plus que ce qu'il a vu (§118.187). Une baisse reste couverte ;
 *   • refusée ou à corriger → on n'y touche pas : la suite appartient au centre (réexamen) ou au
 *     geste de resoumission, qui lit le même montant.
 * Chaque écriture est CONDITIONNELLE à l'état lu : un siège qui tranche pendant la correction gagne,
 * et la correction le constate au lieu d'écraser sa décision. Rend le geste ET l'état qui en résulte,
 * pour que l'appelant DISE ce qui s'est passé et prévienne qui doit l'être.
 */
export type GesteVisa = "AUCUNE" | "OUVERTE" | "RETIREE" | "MISE_A_JOUR" | "ROUVERTE" | "INCHANGEE";

export async function ajusterVisaAuMontant(
  entityType: EntityType,
  entityId: string,
  montant: number | null,
): Promise<{ geste: GesteVisa; etat: EtatVisa | null }> {
  const seuil = await seuilAdProEnVigueur();
  const requise = porteDgRequise(montant, seuil);
  const montantVisa = montant != null && montant > 0 ? montant : null;
  const v = await prisma.adProGateVisa.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { id: true, status: true, amount: true },
  });
  if (!v) {
    if (!requise) return { geste: "AUCUNE", etat: null };
    // Deux corrections simultanées : la seconde retrouve la ligne de la première (`update: {}`).
    await prisma.adProGateVisa.upsert({
      where: { entityType_entityId: { entityType, entityId } },
      create: { entityType, entityId, status: "PENDING", threshold: seuil as number, amount: montantVisa },
      update: {},
    });
    return { geste: "OUVERTE", etat: "PENDING" };
  }
  const etat = lireEtatVisa(v.status);
  if (etat === "PENDING") {
    if (!requise) {
      const r = await prisma.adProGateVisa.deleteMany({ where: { id: v.id, status: "PENDING" } });
      return r.count ? { geste: "RETIREE", etat: null } : { geste: "INCHANGEE", etat: await lireVisaAdPro(entityType, entityId) };
    }
    const r = await prisma.adProGateVisa.updateMany({ where: { id: v.id, status: "PENDING" }, data: { amount: montantVisa } });
    return r.count ? { geste: "MISE_A_JOUR", etat: "PENDING" } : { geste: "INCHANGEE", etat: await lireVisaAdPro(entityType, entityId) };
  }
  if (etat === "APPROVED") {
    const couvert = v.amount == null ? null : toNumber(v.amount);
    // Inconnu d'un côté ou de l'autre : le sens sûr, la porte se rouvre (§118.16).
    const releve = requise && (couvert == null || montant == null || montant > couvert);
    if (!releve) return { geste: "INCHANGEE", etat };
    const dit = (n: number | null) => (n == null ? "un montant non renseigné" : `${n.toLocaleString("fr-FR")} DZD`);
    const r = await prisma.adProGateVisa.updateMany({
      where: { id: v.id, status: "APPROVED" },
      data: {
        status: "PENDING", decidedById: null, decidedAt: null, threshold: seuil as number, amount: montantVisa,
        note: `Montant relevé de ${dit(couvert)} à ${dit(montant)} : l'autorisation précédente ne le couvre pas.`,
      },
    });
    return r.count ? { geste: "ROUVERTE", etat: "PENDING" } : { geste: "INCHANGEE", etat: await lireVisaAdPro(entityType, entityId) };
  }
  return { geste: "INCHANGEE", etat };
}

/**
 * LA PHRASE QUI DIT CE QUE LA CORRECTION A FAIT À LA PORTE — une rédaction pour les quatre appelants
 * (édition, resoumission de chaque nature) : deux rédactions du même fait finiraient par dire deux
 * choses (§118.5). `null` quand il n'y a rien à dire.
 */
export function phraseGesteVisa(geste: GesteVisa, etat: EtatVisa | null): string | null {
  switch (geste) {
    case "OUVERTE": return "le montant dépasse le seuil du centre de validation Ad & Pro : la demande y passe avant sa décision.";
    case "ROUVERTE": return "le montant dépasse ce que le centre de validation Ad & Pro avait autorisé : elle y repasse.";
    case "RETIREE": return "le montant est désormais sous le seuil : la demande ne passe plus par le centre de validation Ad & Pro.";
    case "INCHANGEE":
      if (etat === "REFUSED") return "le centre de validation Ad & Pro avait refusé le dépassement : seul un siège du centre peut le réexaminer.";
      if (etat === "CHANGES_REQUESTED") return "le centre de validation Ad & Pro attend sa correction : « Resoumettre au centre » sur la fiche.";
      return null;
    default: return null;
  }
}

export async function lireVisaAdPro(
  entityType: EntityType,
  entityId: string,
): Promise<EtatVisa | null> {
  const v = await prisma.adProGateVisa
    .findUnique({ where: { entityType_entityId: { entityType, entityId } }, select: { status: true } })
    .catch(sansBloquer("visa.lireVisaAdPro.adProGateVisa", null));
  if (!v) return null;
  return lireEtatVisa(v.status);
}

/** La lecture d'un statut de visa — un statut inconnu ATTEND, le sens sûr (§118.16). */
export function lireEtatVisa(status: string): EtatVisa {
  return status === "APPROVED" || status === "REFUSED" || status === "CHANGES_REQUESTED" ? status : "PENDING";
}

/** Le visa tel que la FICHE le montre : l'état, le motif, qui et quand. `null` = aucune porte. */
export async function lireVisaDetail(
  entityType: EntityType,
  entityId: string,
): Promise<{ etat: EtatVisa; note: string | null; decidedAt: Date | null; decideur: string | null } | null> {
  const v = await prisma.adProGateVisa
    .findUnique({
      where: { entityType_entityId: { entityType, entityId } },
      select: { status: true, note: true, decidedAt: true, decidedBy: { select: { name: true } } },
    })
    .catch(sansBloquer("visa.lireVisaDetail.adProGateVisa", null));
  if (!v) return null;
  return { etat: lireEtatVisa(v.status), note: v.note, decidedAt: v.decidedAt, decideur: v.decidedBy?.name ?? null };
}

/**
 * LE MONTANT QUE LE SEUIL COMPARE, relu sur la fiche — à la resoumission, la demande corrigée peut
 * avoir changé de montant, et c'est ce montant-là que le centre doit voir (§118.187 : un accord ne
 * couvre pas plus que ce qu'il a vu). `null` = non renseigné, ou une nature sans visa.
 */
export async function montantPourLeVisa(entityType: EntityType, entityId: string): Promise<number | null> {
  const brut = entityType === "CONSULTING_CONTRACT"
    ? (await prisma.consultingContract.findUnique({ where: { id: entityId }, select: { amount: true } }).catch(sansBloquer("visa.montantPourLeVisa.consultingContract", null)))?.amount
    : entityType === "AD_PRO_OTHER"
      ? (await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { amount: true } }).catch(sansBloquer("visa.montantPourLeVisa.adProOtherRequest", null)))?.amount
      : null;
  return brut == null ? null : toNumber(brut);
}

/**
 * LA GARDE QUE LES DEUX NATURES APPELLENT AVANT DE TRANCHER.
 *
 * Rend le MOTIF quand ça bloque, `null` quand ça passe — la forme d'un refus qui nomme sa raison
 * (§118.30). Un visa ABSENT laisse passer : sans quoi toutes les demandes déjà en base, créées
 * avant ce lot, se seraient arrêtées net au déploiement sans que personne ait rien décidé.
 */
export async function blocageCentreAdPro(
  entityType: EntityType,
  entityId: string,
): Promise<string | null> {
  const visa = await lireVisaAdPro(entityType, entityId);
  return visaAutoriseAAvancer(visa) ? null : motifBlocageVisa(visa);
}
