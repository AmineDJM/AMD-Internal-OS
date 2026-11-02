import { prisma } from "@/lib/prisma";
import { estKam, estNationalSales, type RolesPersonne } from "@/lib/personnes/roles-vente";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BUSINESS UNIT D'UNE DEMANDE Ad & Pro SE DÉDUIT DE SON AUTEUR — quand elle se déduit.
 *
 * ── CE QUE LA DIRECTION A DEMANDÉ ───────────────────────────────────────────────────────
 *
 * « La Business Unit doit être automatiquement remplie si c'est un KAM ou national sales de
 * cette BU ; si fait par quelqu'un d'autre, alors manuel. »
 *
 * Le rattachement EXISTE déjà en base et à deux endroits distincts, un par métier :
 * `SalesRepProfile.businessUnitId` dit la gamme d'un KAM, `BusinessUnit.supervisorId` dit le
 * superviseur national d'une gamme. On les LIT — écrire ici une troisième table de
 * correspondance serait fausse au premier changement d'équipe, en silence (§118.73).
 *
 * ── POURQUOI C'EST AUSSI UNE GARDE, ET PAS SEULEMENT UN CONFORT DE SAISIE ───────────────
 *
 * Le champ était un menu LIBRE : un KAM de la gamme oncologie pouvait poster
 * `businessUnitId` = cardiologie et faire peser sa dépense sur le budget Ad&Pro d'une autre
 * gamme. Le pré-remplissage seul n'y changerait rien — un champ de formulaire se forge. C'est
 * pourquoi la valeur déduite s'IMPOSE côté serveur : là où la BU se lit sur la personne, le
 * choix de la personne n'entre pas en ligne de compte. Là où elle ne se lit pas, la saisie
 * reste libre, et c'est le comportement d'avant.
 *
 * ── ET CE QU'ON REFUSE DE DEVINER ───────────────────────────────────────────────────────
 *
 * Un superviseur national de DEUX gammes ne désigne aucune des deux : en collapser une
 * choisirait à sa place la gamme dont le budget sera engagé (§118.34). On rend `null`, la
 * saisie redevient manuelle, et l'écran le DIT. Idem pour un KAM dont la fiche de force de
 * vente n'est pas rattachée : on ne remplit pas un champ budgétaire par ressemblance de nom.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BuDeduite {
  id: string;
  name: string;
  /** La phrase à montrer sous le champ — pourquoi cette gamme et pas une autre. */
  raison: string;
}

interface DemandeurBu extends RolesPersonne {
  id: string;
}

/**
 * La gamme que porte cette personne, ou `null` quand elle ne se lit pas À COUP SÛR.
 *
 * L'ordre compte : la fiche de KAM est le rattachement le plus PRÉCIS (une personne, une
 * équipe), la supervision le plus large. Quelqu'un qui est les deux — un superviseur qui garde
 * un secteur — porte d'abord sa propre gamme de KAM.
 */
export async function businessUnitDuDemandeur(user: DemandeurBu): Promise<BuDeduite | null> {
  if (estKam(user)) {
    const fiche = await prisma.salesRepProfile
      .findUnique({
        where: { repId: user.id },
        select: { businessUnit: { select: { id: true, name: true, isActive: true } } },
      })
      .catch(sansBloquer("business-unit-auto.businessUnitDuDemandeur.salesRepProfile", null));
    const bu = fiche?.businessUnit;
    if (bu && bu.isActive) {
      return { id: bu.id, name: bu.name, raison: `Votre gamme — rattachement de votre fiche force de vente.` };
    }
  }

  if (estNationalSales(user)) {
    // On lit DEUX gammes au plus : il n'en faut pas plus pour savoir s'il y a ambiguïté, et
    // charger toute la liste pour n'en garder qu'une serait un travail inutile à chaque
    // ouverture de formulaire.
    const supervisees = await prisma.businessUnit
      .findMany({ where: { supervisorId: user.id, isActive: true }, select: { id: true, name: true }, take: 2 })
      .catch(sansBloquer("business-unit-auto.businessUnitDuDemandeur.businessUnit", [] as { id: string; name: string }[]));
    if (supervisees.length === 1) {
      const bu = supervisees[0]!;
      return { id: bu.id, name: bu.name, raison: `Gamme dont vous êtes le superviseur national.` };
    }
    // Deux gammes ou plus : on ne choisit pas laquelle paiera.
  }

  return null;
}

/**
 * LA GAMME QU'ON ÉCRIT SUR UNE DEMANDE — LA MÊME RÈGLE POUR LES SIX NATURES.
 *
 * « Si un KAM fait déjà partie d'une BU, quand il fait une demande Ad&Pro, ça ne doit pas lui
 * proposer le champ « Business Unit » » (Direction, 05/10). Le champ disparaît des formulaires
 * quand la gamme se lit sur la personne (`businessUnitDuDemandeur`) : sans lui, rien n'arrive plus
 * du navigateur, et c'est le SERVEUR qui la pose — pour les cinq natures qui écrivent une gamme
 * (sponsoring, congrès international et national, événement, consulting, autre demande). Seul le
 * sponsoring l'imposait ; les quatre autres lisaient le formulaire tel quel, donc masquer le champ
 * sans cette règle les aurait fait naître SANS gamme — la dépense à la charge de personne.
 *
 * Là où la gamme se lit, la valeur postée est IGNORÉE : un champ de formulaire se forge, et une
 * gamme forgée fait peser la dépense sur le budget d'une autre équipe. Là où elle ne se lit pas
 * (Direction, superviseur de plusieurs gammes, personne sans rattachement), la saisie reste
 * souveraine — le comportement d'avant.
 *
 * La valeur postée se lit DANS L'ACTION, en littéral (`fdStr(formData, "businessUnitId")`) : la
 * dérivation des contrats d'action ne suit pas la lecture d'un formulaire dans un module importé
 * (§118.143), et le champ disparaîtrait de la fiche d'Adam.
 */
export async function gammeImposee(user: DemandeurBu, posted: string | null): Promise<string | null> {
  const deduite = await businessUnitDuDemandeur(user);
  return deduite?.id ?? (posted || null);
}
