/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — DOMAINE « mails » (lot P1 bis, décision 0047) : RÉDIGER des mails de tout genre.
 * Identifiants : ML-. Agrégé par `./index.ts` ; les attaques ML-ADAM- (le canal d'Adam, réservé au Super Admin) sont
 * dans `../attaques.ts`.
 *
 * Chaque tâche : la carte d'envoi (JAMAIS cliquée — aucun envoi), zéro ou une question, la GRILLE déterministe du mail
 * (`noterMail` : destinataires, objet, salutation, structure, tableau, politesse — français ou anglais —, signature,
 * aucun gabarit oublié) puis le JUGE ; `contient` / `interdit` sur la réponse et la carte. Pour toute persona autre que
 * le Super Admin, le canal d'Adam ne se NOMME jamais (`MOTS_DU_CANAL_ADAM`, interdit ajouté d'office).
 *
 * LE SEMIS (`SEMIS_MAILS`, clés « ml- ») : les pièces à joindre (BC, facture, attestation) dans le Drive de qui les
 * envoie, et un mail reçu d'un client, joint au message (réponse à un mail reçu, K6).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { MOTS_DU_CANAL_ADAM } from "../../../../domaine/mails/canal";
import { nomComplet, type PersonaCle } from "../personas";
import { deposerPiece, pdf } from "./aides";
import { tache, type ContexteVerification, type SemisDeDomaine, type Tache } from "./types";

const CARTE_MAIL = /mail|courri|message|envoi/i;

/** Une tâche de rédaction : la carte d'envoi attendue, le mail noté, jamais confirmée (aucun envoi). */
const m = (id: string, persona: PersonaCle, tours: string | string[], o: { tableau?: boolean; contient?: RegExp[]; interdit?: RegExp[]; questionsMax?: number; precision?: string; voix?: boolean; piece?: string } = {}): Tache =>
  tache(id, "mail", persona, tours, {
    carte: CARTE_MAIL, mail: { tableau: o.tableau }, objet: "mail", sansConfirmer: true,
    // Le canal d'Adam n'existe que pour le Super Admin : pour tout autre, il ne se dit jamais.
    interdit: [...(o.interdit ?? []), ...(persona === "superadmin" ? [] : [MOTS_DU_CANAL_ADAM])],
    ...(o.questionsMax != null ? { questionsMax: o.questionsMax } : {}),
  }, {
    ...(o.precision ? { precision: o.precision } : {}),
    ...(o.voix ? { voix: true } : {}),
    ...(o.piece ? { piece: o.piece } : {}),
    // Le CONTENU attendu se cherche dans le MAIL (la charge de la carte : objet, corps) autant que dans la réponse.
    ...(o.contient ? { verifier: async (c) => contenuAttendu(c, o.contient!) } : {}),
  });

/** Les motifs absents à la fois de la réponse, des champs et de la charge de la carte (le mail rédigé). */
function contenuAttendu(c: ContexteVerification, motifs: RegExp[]): string[] {
  const tout = [...c.reponses, ...(c.carte ? [c.carte.titre, ...c.carte.champs, JSON.stringify(c.carte.payload ?? null)] : [])].join("\n");
  return motifs.filter((re) => !re.test(tout)).map((re) => `contenu attendu absent du mail : ${re.source.slice(0, 40)}`);
}

const RADIA = nomComplet("commercial");
const NADIR = nomComplet("manager");

export const TACHES_MAILS: Tache[] = [
  // ── Remerciements ──
  m("ML-11-remerciement-chu", "kam", "Écris un mail de remerciement au Pr Benali (pr.benali@chu-oran.dz) pour son intervention au staff d'oncologie de mardi.", { contient: [/merci|remerci/i] }),
  m("ML-12-remerciement-equipe", "manager", `Envoie un mail à ${RADIA} pour la remercier de son excellent travail sur la tournée de l'Est.`, { contient: [/merci|remerci|bravo|félicit/i] }),
  m("ML-13-remerciement-fournisseur", "assistante", "Fais un mail de remerciement à contact@traiteur-elbahia.dz pour la qualité du déjeuner du comité.", { contient: [/merci|remerci/i] }),

  // ── Relances fournisseur ──
  m("ML-14-relance-devis", "finance", "Relance par mail commercial@imprimerie-atlas.dz : on attend toujours leur devis pour les 5 000 brochures, demandé il y a dix jours.", { contient: [/devis/i] }),
  m("ML-15-relance-livraison", "assistante", "Fais un mail ferme mais courtois à logistique@transports-hoggar.dz : la livraison des présentoirs prévue le 25 octobre n'est toujours pas arrivée.", { contient: [/livraison|présentoir/i] }),
  m("ML-16-relance-facture", "finance", "Relance par mail compta@clinique-el-azhar.dz pour la facture FA-2026-0912 de 480 000 DZD, échue depuis le 15 octobre.", { contient: [/FA-2026-0912|facture/i] }),

  // ── Invitations ──
  m("ML-17-invitation-congres", "kam", "Rédige un mail d'invitation au symposium Adventum d'oncologie du 4 décembre à l'hôtel Sheraton d'Oran, pour dr.kaci@clinique-oran.dz. Programme en tableau : 9 h accueil, 9 h 30 immunothérapie, 11 h table ronde, 12 h 30 déjeuner.", { tableau: true, contient: [/symposium|Sheraton/i] }),
  m("ML-18-invitation-webinaire", "commercial", "Invite par mail pharmacie.centrale@blida.dz à notre webinaire du jeudi 20 novembre à 14 h sur le bon usage du Daclavir.", { contient: [/webinaire/i] }),
  m("ML-19-invitation-interne", "assistante", `Envoie un mail à ${NADIR} et ${RADIA} pour les inviter au séminaire commercial du 15 décembre à Alger, avec le programme : matin bilan 2026, après-midi objectifs 2027.`, { contient: [/séminaire/i] }),

  // ── Réponse à un mail reçu (K6) ──
  m("ML-20-reponse-recu-joint", "kam", "Réponds à ce mail du client, poliment : la commande sera livrée jeudi 20 novembre.", { piece: "ml-mail-recu-client", contient: [/jeudi|20 novembre/i] }),
  m("ML-21-reponse-colle", "commercial", "Réponds à ce mail : « Bonjour, pouvez-vous nous confirmer la date de livraison de notre commande n° 4471 ? Cordialement, Pharmacie Ziani (contact@pharmacie-ziani.dz) ». La livraison est prévue mardi 18 novembre.", { contient: [/4471|mardi|18 novembre/i] }),

  // ── Comptes rendus ──
  m("ML-22-compte-rendu", "manager", `Envoie le compte rendu de la réunion d'équipe de ce matin à ${RADIA} : décisions en tableau — objectifs Q4 validés (Nadir), tournée Est avancée au 10 novembre (Radia), commande d'échantillons (Yanis).`, { tableau: true, contient: [/compte rendu|réunion/i] }),
  m("ML-23-compte-rendu-client", "kam", "Fais le compte rendu par mail au Dr Haddad (dr.haddad@chu-mustapha.dz) de notre rendez-vous d'hier : présentation de la gamme oncologie, intérêt pour le Nivolumab, prochaine visite le 2 décembre.", { contient: [/Nivolumab|2 décembre/i] }),

  // ── Demandes de devis ──
  m("ML-24-demande-devis", "assistante", "Fais une demande de devis par mail à devis@agence-pixel.dz : conception et impression de 300 kakémonos 80×200 cm, livraison avant le 10 décembre.", { contient: [/devis|kakémono/i] }),
  m("ML-25-demande-devis-hotel", "kam", "Demande par mail un devis à reservations@hotel-aurassi.dz : salle de 60 personnes et pause-café pour le 28 novembre, une journée.", { contient: [/devis|salle/i] }),

  // ── Refus polis ──
  m("ML-26-refus-sponsoring", "superadmin", "Réponds par mail à contact@association-sante-tlemcen.dz que nous ne pourrons pas sponsoriser leur journée cette année, budget épuisé — mais qu'on reste ouverts pour 2027.", { contient: [/2027/] }),
  m("ML-27-refus-offre", "regulatory", "Fais un mail poli à consultant@regconseil.dz pour décliner leur offre d'accompagnement réglementaire, nous gérons en interne.", { contient: [/décliner|pas donner suite|ne pas|interne/i] }),

  // ── En anglais ──
  m("ML-28-anglais-partenaire", "regulatory", "Write an email in English to regulatory@kwality-pharma.com asking for the updated stability data of the Nivolumab batch for our ANPP file, needed before November 30.", { contient: [/stability|Nivolumab/i] }),
  m("ML-29-anglais-congres", "kam", "Envoie un mail EN ANGLAIS à secretariat@esmo.org pour demander les conditions d'inscription d'un groupe de 12 médecins algériens au congrès ESMO.", { contient: [/registration|register|group/i] }),

  // ── Pièce jointe de l'ERP (BC, facture, attestation) — jointe par le canal qui le permet, sinon DITE ──
  m("ML-30-piece-jointe-drive", "delegue", `Envoie par mail à ${NADIR} le fichier « Tableau primes Q3.xlsx » de mon Drive, avec un mot d'accompagnement.`, { contient: [/Tableau primes|pi[eè]ce|joint|Drive/i], interdit: [/18[\s  .]?000|64[\s  .]?000/] }),
  m("ML-31-bc-fournisseur", "assistante", "Envoie le fichier « BC imprimerie Atlas » de mon Drive à commercial@imprimerie-atlas.dz, en pièce jointe, avec un mail court qui confirme la commande.", { contient: [/BC|bon de commande|pi[eè]ce|joint/i] }),
  m("ML-32-facture-client", "finance", "Envoie la « Facture CHU novembre » de mon Drive à compta@chu-mustapha.dz, en pièce jointe, avec un mail de transmission.", { contient: [/facture|pi[eè]ce|joint/i] }),
  m("ML-33-attestation", "rh", "Envoie l'« Attestation de travail Yanis » de mon Drive à credit@bna.dz, en pièce jointe, avec un mail de transmission.", { contient: [/attestation|pi[eè]ce|joint/i] }),

  // ── Divers : annonce, félicitations, voix ──
  m("ML-34-annonce-nouveau", "rh", `Fais un mail à ${NADIR} pour annoncer l'arrivée d'une nouvelle déléguée, Amel, le 1er décembre, dans son équipe.`, { contient: [/Amel|1er décembre/i] }),
  m("ML-35-felicitations", "manager", `Envoie un mail de félicitations à ${RADIA} pour le contrat signé avec la clinique El Azhar.`, { contient: [/félicit|bravo/i] }),
  m("ML-36-voix-relance", "commercial", "Fais un mail à achats@pharmacie-blida.dz pour relancer le paiement de la commande d'octobre.", { voix: true }),
  m("ML-37-direction-groupe", "superadmin", "Envoie un mail à toute la direction pour fixer le comité budgétaire au lundi 17 novembre à 9 h, salle du conseil.", { contient: [/comité|17 novembre/i] }),
  m("ML-38-question-canal-sa", "superadmin", "Par quelle boîte partiront mes mails ? Prépare ensuite un mail à contact@sahge.dz pour confirmer notre stand au congrès.", { contient: [/Adam|ERP|Gmail/i] }),
];

/** Les pièces du domaine : ce que les personas joignent (dans LEUR Drive) et le mail reçu à qui répondre. */
export const SEMIS_MAILS: SemisDeDomaine = async ({ users }) => {
  const recu = await deposerPiece(users.kam, "Mail reçu — achats@clinique-hydra.dz.txt", Buffer.from([
    "De : achats@clinique-hydra.dz", "À : Adventum Pharma", "Objet : date de livraison commande CMD-2026-311", "",
    "Bonjour,", "Pourriez-vous nous confirmer la date de livraison de notre commande CMD-2026-311 (Nivolumab, 40 boîtes) ?", "Bien cordialement,", "Service achats — Clinique d'Hydra",
  ].join("\n"), "utf8"));
  return {
    "ml-mail-recu-client": recu,
    "ml-bc-imprimerie": await deposerPiece(users.assistante, "BC imprimerie Atlas.pdf", await pdf(["BON DE COMMANDE BC-2026-0418", "Fournisseur : Imprimerie Atlas", "5 000 brochures A5 quadri — 185 000 DZD HT"])),
    "ml-facture-chu": await deposerPiece(users.finance, "Facture CHU novembre.pdf", await pdf(["FACTURE FA-2026-1203", "Client : CHU Mustapha", "Nivolumab 100 mg × 60 — 2 940 000 DZD TTC"])),
    "ml-attestation": await deposerPiece(users.rh, "Attestation de travail Yanis.pdf", await pdf(["ATTESTATION DE TRAVAIL", "Nous attestons que M. Yanis HAMDI est employé en CDI depuis le 1er mars 2023."])),
  };
};
