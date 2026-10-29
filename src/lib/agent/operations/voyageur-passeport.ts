import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { ajouterVoyageur } from "@/modules/ad-pro/actions-postes-voyageurs";
import { porteDesVoyageurs } from "@/modules/ad-pro/partage";
import type { CurrentUser } from "@/lib/session";
import { champs, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive, resoudrePiece } from "./pieces";
import { trouverDemande, type NatureDemande } from "./demandes-visibles";
import { dateIso } from "./adpro-prise-en-charge";
import { replier } from "./annuaire-medical";
import { texteDesOctets } from "./documents-lus";
import { casse, lireMrz } from "./mrz";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PASSEPORT → UN VOYAGEUR DE L'ERP — sans que le modèle en voie une lettre.
 *
 * Le passeport est lu SUR CE SERVEUR (OCR local, `cloud: false`), sa zone MRZ décodée et contrôlée
 * (`mrz.ts`). Les valeurs — nom, prénoms, expiration — vont sur la CARTE, que seule la personne
 * voit, puis dans la fiche voyageur du poste « billetterie » par l'action de l'écran
 * (`ajouterVoyageur`), le passeport joint en pièce d'identité.
 *
 * Ce que le MODÈLE reçoit : « carte prête » et des avertissements SANS valeur (« le passeport expire
 * moins de six mois après le retour »). Ni le titre de la carte, ni un refus, ni le message final
 * ne nomment la personne : le contexte de l'assistant ne contient jamais l'identité lue.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CHAMP_PARENT: Partial<Record<NatureDemande, "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId">> = {
  SPONSORING: "sponsoringId", CONGRESS_NATIONAL: "congressNationalId", CONGRESS_INTERNATIONAL: "congressInternationalId", EVENT: "eventId",
};

const SIX_MOIS_MS = 182 * 24 * 3600 * 1000;

export const VOYAGEUR_PASSEPORT: OperationIA = {
  nom: "preparer_voyageur_passeport",
  module: "SPONSORING",
  libelle: "Voyageur préparé depuis un passeport",
  description:
    "AJOUTE UN VOYAGEUR à un poste « billetterie » d'une demande Ad & Pro à partir de son PASSEPORT (fichier du Drive ou glissé dans la conversation). "
    + "Le passeport est lu localement : TU NE VOIS PAS son contenu, et tu ne dois jamais demander ni répéter le nom, le numéro ou les dates du passeport — "
    + "la carte les montre à l'utilisateur. Donne seulement la demande, et si l'utilisateur les cite, les villes et dates du voyage. Elle répond `manque` — "
    + "pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      fichier: { type: "string", description: "Le passeport : nom ou identifiant du fichier." },
      demande: { type: "string", description: "Référence ou nom de la demande Ad & Pro (sponsoring, prise en charge, événement)." },
      poste: { type: "string", description: "Le poste billetterie, s'il y en a plusieurs (libellé)." },
      villeDepart: { type: "string" },
      villeArrivee: { type: "string" },
      depart: { type: "string", description: "AAAA-MM-JJ" },
      retour: { type: "string", description: "AAAA-MM-JJ" },
    },
  },
  ouverte: (u) => ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS"].some((m) => userCan(u, m as never, "UPDATE") || userCan(u, m as never, "CREATE")),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const demande = await trouverDemande(user, texte(e, "demande"), "");
    const manque = [
      !texte(e, "fichier") ? "le passeport : glissez-le dans la conversation (page d'identité, à plat, nette)" : null,
      "manque" in demande ? demande.manque : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const d = demande as Exclude<typeof demande, { manque: string }>;
    const champ = CHAMP_PARENT[d.nature];
    if (!champ) return { erreur: "Les voyageurs s'ajoutent au poste billetterie d'un sponsoring, d'une prise en charge ou d'un événement." };
    const postes = (await prisma.adProItem.findMany({ where: { [champ]: d.id }, select: { id: true, label: true, kind: true } }))
      .filter((p) => porteDesVoyageurs(p.kind));
    if (!postes.length) return { erreur: "Cette demande n'a pas de poste « billetterie » : ajoutez-le d'abord (preparer_poste)." };
    const voulu = replier(texte(e, "poste"));
    const choisis = voulu ? postes.filter((p) => replier(p.label).includes(voulu)) : postes;
    if (choisis.length !== 1) return { manque: [`quel poste billetterie : ${postes.map((p) => `« ${p.label} »`).join(", ")}`] };
    const poste = choisis[0]!;

    const piece = await resoudrePiece(user, texte(e, "fichier"));
    if ("erreur" in piece) return { erreur: piece.erreur };
    const f = await fichiersDepuisDrive(user, [piece.id]);
    if (!Array.isArray(f) || !f[0]) return { erreur: "Le passeport est introuvable." };
    const lu = await texteDesOctets(piece.nom, Buffer.from(await f[0].arrayBuffer()));
    const mrz = lireMrz(lu.texte);
    if (!mrz) {
      return { erreur: "La zone de lecture automatique (les deux lignes de chevrons en bas de la page d'identité) n'a pas pu être lue sur ce serveur. Joignez une photo nette et à plat de la page d'identité, ou saisissez le voyageur depuis le poste." };
    }

    const depart = dateIso(texte(e, "depart"));
    const retour = dateIso(texte(e, "retour"));
    const warnings = ["Lu sur ce serveur : le nom, le numéro et les dates du passeport n'ont pas été transmis à l'assistant. Vérifiez-les ci-dessus."];
    if (mrz.controlesFaux.length) warnings.push(`Contrôle de la zone MRZ en échec (${mrz.controlesFaux.join(", ")}) : comparez la carte au passeport avant de confirmer.`);
    const finVoyage = retour ?? depart;
    if (mrz.expiration && finVoyage && new Date(mrz.expiration).getTime() - new Date(finVoyage).getTime() < SIX_MOIS_MS) {
      warnings.push("Le passeport expire moins de six mois après la fin du voyage : de nombreux pays refusent l'entrée.");
    } else if (mrz.expiration && new Date(mrz.expiration).getTime() < Date.now()) {
      warnings.push("Le passeport est expiré.");
    }
    const homonymes = await prisma.adProVoyageur.count({ where: { itemId: poste.id, nom: { equals: casse(mrz.nom), mode: "insensitive" } } });
    if (homonymes) warnings.push("Un voyageur du même nom figure déjà sur ce poste : vérifiez que ce n'est pas un doublon.");

    return {
      carte: {
        title: "Voyageur depuis le passeport",
        fields: champs([
          ["Demande", d.libelle],
          ["Poste", poste.label],
          ["Nom (passeport)", casse(mrz.nom)],
          ["Prénom(s) (passeport)", casse(mrz.prenoms) || null],
          ["Passeport valable jusqu'au", mrz.expiration],
          ["Trajet", texte(e, "villeDepart") || texte(e, "villeArrivee") ? `${texte(e, "villeDepart") || "?"} → ${texte(e, "villeArrivee") || "?"}` : null],
          ["Dates", depart || retour ? `${depart ?? "?"} → ${retour ?? "?"}` : null],
          ["Pièce jointe", "Le passeport, en pièce d'identité du voyageur"],
        ]),
        warnings,
        libelleBouton: "Ajouter le voyageur",
      },
      args: {
        itemId: poste.id, nom: casse(mrz.nom), prenom: casse(mrz.prenoms) || null, passeport: piece.id,
        villeDepart: texte(e, "villeDepart") || null, villeArrivee: texte(e, "villeArrivee") || null,
        dateDepart: depart, dateRetour: retour, lien: d.lien,
      },
    };
  },

  async executer(a, user) {
    const f = await fichiersDepuisDrive(user, a.passeport ? [a.passeport] : []);
    if (!Array.isArray(f) || !f[0]) return { ok: false, error: Array.isArray(f) ? "Le passeport est introuvable." : f.erreur };
    const fd = new FormData();
    for (const cle of ["itemId", "nom", "prenom", "villeDepart", "villeArrivee", "dateDepart", "dateRetour"]) if (a[cle]) fd.set(cle, a[cle]!);
    fd.append("passeport", f[0]);
    const r = await ajouterVoyageur(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "Le voyageur n'a pas pu être ajouté." };
    // Le message ne nomme pas le voyageur : il peut revenir au modèle dans l'historique.
    return { ok: true, message: r.message ?? "Voyageur ajouté avec son passeport.", ...(a.lien ? { link: a.lien } : {}), revalidate: [a.lien ?? "/ad-pro"] };
  },
};
