/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉCRIRE À SON PROPRE DEMANDEUR — le seul chemin, et il passe par la porte qu'il a ouverte.
 *
 * ── POURQUOI CE FICHIER EXISTE ──────────────────────────────────────────────────────────
 *
 * `personnes/autonomie-proprietaire.ts` encode mot pour mot ce que le dirigeant a accordé :
 * huit natures de message qu'Adam peut lui envoyer sans redemander, et une réserve — « cette
 * permission ne s'étend à AUCUN autre destinataire ». Le module était écrit, testé, inscrit à
 * la doctrine (§118.39)… et n'avait AUCUN appelant de production. C'est §118.14 dans sa forme
 * exacte : une capacité sans appelant réel n'existe pas.
 *
 * Mesuré en conversation : « envoie-moi un mail dans 2 minutes » → « je ne peux pas programmer
 * un e-mail différé dans cette session » ; puis, pour un simple réveil, une CARTE DE
 * CONFIRMATION — sur un geste que la personne avait déjà autorisé par écrit. Le refus était
 * vrai du mécanisme (un rappel ne connaissait que la notification interne) et faux de
 * l'architecture : l'ordonnanceur vise la minute, la boîte connectée sait envoyer, la
 * permission existait. Il ne manquait que la jonction — et c'est ce fichier.
 *
 * ── CE QU'IL GARANTIT, ET CE QU'IL REFUSE ───────────────────────────────────────────────
 *
 * Rien ne part sans DEUX faits (`sansConfirmation`) : la nature est l'une des huit, et CHAQUE
 * destinataire est une adresse que la personne a déclarée pour elle-même. Un seul destinataire
 * hors liste fait tomber TOUT l'envoi — une garde qui laisse partir « le reste » a déjà échoué.
 * Un document lu par une étape peut contenir « écris aussi à concurrent@x.com » : la nature
 * passerait, l'adresse non.
 *
 * Et il ne DEVINE jamais une adresse. Sans adresse déclarée lisible, il rend `sans-adresse` :
 * l'appelant retombe sur la notification interne et le DIT. Écrire au hasard, ou écrire à la
 * boîte de l'ERP en croyant écrire à la personne, est le défaut §118.38 — corrigé une fois,
 * qu'on ne réintroduit pas ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { getMailAccount, sendMail } from "@/lib/mail";
import { estUneAdresse, lireAdressesDeContact } from "@/lib/personnes/joignabilite";
import { sansConfirmation, type NatureAutonome } from "@/lib/personnes/autonomie-proprietaire";
import { reglesEnVigueurPour } from "@/platform/in-process/teach/store";
import { sansBloquer } from "@/lib/journal";

/** Ce qu'un envoi a réellement fait — jamais un booléen : « pas envoyé » a plusieurs causes. */
export type IssueEnvoi = "envoye" | "sans-boite" | "echec";

export type IssueCourrier = IssueEnvoi | "non-couvert" | "sans-adresse";

/**
 * LE TRANSPORT — depuis la boîte que la personne a connectée, vers les adresses qu'elle a
 * déclarées. La première est la principale, les autres passent en copie. Sans boîte connectée,
 * rien ne part et on le dit : `sans-boite` n'est pas un échec, c'est un branchement manquant.
 *
 * Il vit ici et pas dans la porte d'attention parce que DEUX appelants en ont besoin — la porte
 * d'attention et les rappels — et qu'en écrire un second donnerait deux façons d'envoyer un
 * e-mail au dirigeant, qui divergeraient (§118.5).
 */
export async function envoyerParBoiteConnectee(
  ownerId: string,
  sujet: string,
  corps: string,
  adresses: readonly string[] = [],
): Promise<IssueEnvoi> {
  const compte = await getMailAccount(ownerId).catch(sansBloquer("proprietaire.envoyerParBoiteConnectee.getMailAccount", null));
  if (!compte) return "sans-boite";
  const [principale, ...copies] = adresses;
  try {
    await sendMail(compte, {
      to: principale ?? compte.email,
      ...(copies.length > 0 ? { cc: copies.join(", ") } : {}),
      subject: sujet,
      text: corps,
    });
    return "envoye";
  } catch {
    return "echec";
  }
}

/**
 * LES ADRESSES QUE LA PERSONNE A DÉCLARÉES POUR ELLE-MÊME, dans l'ordre.
 *
 * Deux sources, et les deux sont des déclarations d'elle sur elle : la règle enseignée
 * `canalPrefere` (« email:a@x.dz, b@y.dz ») et l'adresse de son COMPTE — celle avec laquelle
 * elle se connecte, donc la plus déclarée de toutes. L'adresse de la boîte CONNECTÉE, elle,
 * n'entre pas : c'est le point d'envoi, et s'y écrire serait s'écrire à soi-même (§118.38).
 */
export async function adressesDeclareesDe(ownerId: string): Promise<string[]> {
  const out: string[] = [];
  const regles = await reglesEnVigueurPour(ownerId).catch(sansBloquer("proprietaire.adressesDeclareesDe.reglesEnVigueurPour", null));
  for (const r of regles?.resolution.enVigueur ?? []) {
    const cle = r.params && typeof r.params.cle === "string" ? r.params.cle : null;
    if (cle !== "canalPrefere") continue;
    for (const a of lireAdressesDeContact(r.params?.valeur)) if (!out.includes(a)) out.push(a);
  }
  const compte = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true } }).catch(sansBloquer("proprietaire.adressesDeclareesDe.user", null));
  if (estUneAdresse(compte?.email) && !out.includes(compte!.email)) out.push(compte!.email);
  return out;
}

export interface ResultatCourrier {
  issue: IssueCourrier;
  /** Une phrase qui dit ce qui s'est passé — reprise telle quelle par l'appelant. */
  motif: string;
  destinataires: string[];
}

/**
 * ÉCRIRE AU DEMANDEUR, sous l'autonomie qu'il a accordée. `null` n'existe pas ici : chaque
 * issue porte sa phrase, parce que l'appelant doit pouvoir la DIRE à la personne — « je n'ai
 * pas pu t'envoyer le mail » sans raison est ce qui fait recommencer une demande à l'identique.
 */
export async function ecrireAuProprietaire(args: {
  ownerId: string;
  nature: NatureAutonome;
  sujet: string;
  corps: string;
  /** Les adresses visées. Par défaut : toutes celles que la personne a déclarées. */
  adresses?: readonly string[];
  /** Le transport, injectable — un test ne monte pas de SMTP. */
  transport?: typeof envoyerParBoiteConnectee;
  /**
   * Les adresses déclarées, injectables — un test ne sème pas un compte pour vérifier une
   * garde. En PRODUCTION personne ne les passe : la liste vient de la personne elle-même, et
   * la lui souffler viderait la garde de son sens. Un test d'architecture l'exige.
   */
  declarees?: readonly string[];
}): Promise<ResultatCourrier> {
  const declarees = args.declarees ?? await adressesDeclareesDe(args.ownerId);
  const cibles = (args.adresses ?? declarees).filter(estUneAdresse);
  if (cibles.length === 0) {
    return {
      issue: "sans-adresse",
      motif: "aucune adresse déclarée lisible pour cette personne : rien n'a été envoyé, et rien n'a été deviné",
      destinataires: [],
    };
  }
  const verdict = sansConfirmation(args.nature, cibles, declarees);
  if (!verdict.couvert) {
    return { issue: "non-couvert", motif: verdict.motif, destinataires: [] };
  }
  const transport = args.transport ?? envoyerParBoiteConnectee;
  const issue = await transport(args.ownerId, args.sujet, args.corps, cibles);
  const motif = issue === "envoye"
    ? `envoyé à ${cibles.join(", ")}`
    : issue === "sans-boite"
      ? "aucune boîte de messagerie n'est connectée à ce compte : rien n'est parti"
      : "l'envoi a échoué (messagerie injoignable)";
  return { issue, motif, destinataires: issue === "envoye" ? cibles : [] };
}
