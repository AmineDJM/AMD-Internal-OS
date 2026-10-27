import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { createValidationRequest } from "@/lib/actions/validation-actions";
import { companyIdForNew } from "@/lib/company";
import { getAppSettings } from "@/lib/settings";
import { validationRequiseBC } from "@/lib/bons-de-commande/regle";
import { peutCreerUnBC } from "@/lib/bons-de-commande/retenue-bc";
import { findPartyByName } from "@/lib/queries/company-contacts";
import type { CurrentUser } from "@/lib/session";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive, idsDe, resoudrePiece } from "./pieces";
import { replier } from "./annuaire-medical";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BON DE COMMANDE ET SA DEMANDE DE VALIDATION — « Créer la demande de validation ».
 *
 * Par l'action de l'écran Validations (`createValidationRequest`, objet « bon de commande ») : le
 * BC déposé (fichier du Drive ou glissé dans la conversation) s'enregistre au registre Legal, est
 * RETENU pour la pré-validation du validateur choisi, puis suit l'aiguillage de l'ERP — le centre
 * de validation au-dessus du seuil, la signature des Finances dans tous les cas. La carte le dit
 * AVANT : c'est l'avertissement « il faut passer par les Finances ».
 *
 * LA SOCIÉTÉ : l'ERP inscrit un BC sur la société SÉLECTIONNÉE dans la barre du haut, à défaut
 * celle de la personne (`companyIdForNew`). L'opération ne contourne pas cette règle : elle dit la
 * société qui sera inscrite, et si la personne en veut une autre, elle lui dit de la sélectionner.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function nomSociete(id: string | null): Promise<string | null> {
  if (!id) return null;
  const c = await prisma.company.findUnique({ where: { id }, select: { name: true, shortName: true } });
  return c ? c.shortName || c.name : null;
}

export async function validateur(user: CurrentUser, nom: string): Promise<{ id: string; nom: string } | { manque: string }> {
  if (!nom) return { manque: "qui doit valider ce bon de commande (le validateur principal)" };
  const t = await prisma.user.findMany({ where: { isActive: true, id: { not: user.id }, name: { contains: nom, mode: "insensitive" } }, select: { id: true, name: true }, take: 5 });
  const exact = t.filter((u) => replier(u.name) === replier(nom));
  const un = exact.length === 1 ? exact[0] : t.length === 1 ? t[0] : null;
  if (un) return { id: un.id, nom: un.name };
  return { manque: t.length > 1 ? `quel validateur : ${t.map((u) => u.name).join(", ")}` : `« ${nom} » n'a pas de compte actif (et on ne se valide pas soi-même) : un autre validateur` };
}

export const BON_DE_COMMANDE: OperationIA = {
  nom: "preparer_bon_de_commande",
  module: "VALIDATIONS",
  libelle: "Bon de commande préparé",
  description:
    "PRÉPARE un BON DE COMMANDE et sa DEMANDE DE VALIDATION (bouton « Créer la demande de validation ») : le fichier du BC (Drive ou conversation), "
    + "le fournisseur, le montant, le validateur. Elle dit la société sur laquelle le BC s'inscrit (par défaut celle de l'employé) et prévient du "
    + "passage par le centre de validation et la signature des Finances. Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      objet: { type: "string", description: "Objet de la commande." },
      fournisseur: { type: "string", description: "Fournisseur (tel qu'il est dans l'annuaire de l'entreprise)." },
      montant: { type: "number", description: "Montant du BC, en DZD." },
      numero: { type: "string", description: "Numéro du BC s'il en a un." },
      fichier: { type: "string", description: "Le BC : nom ou identifiant du fichier (Drive ou conversation)." },
      validateur: { type: "string", description: "Le validateur principal (nom d'un collègue)." },
      societe: { type: "string", description: "La société souhaitée, si l'utilisateur la précise." },
      description: { type: "string" },
    },
  },
  ouverte: (u) => userCan(u, "VALIDATIONS", "CREATE") && peutCreerUnBC(u),

  async proposer(e, user): Promise<PropositionOperation> {
    const montant = nombre(e, "montant");
    const val = await validateur(user, texte(e, "validateur"));
    const manque = [
      !texte(e, "objet") ? "l'objet de la commande" : null,
      !texte(e, "fournisseur") ? "le fournisseur" : null,
      montant == null ? "le montant du bon de commande (DZD)" : null,
      !texte(e, "fichier") ? "le bon de commande lui-même : glissez le fichier dans la conversation ou nommez-le dans le Drive" : null,
      "manque" in val ? val.manque : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    if (montant! <= 0) return { erreur: "Le montant d'un bon de commande est positif." };
    const v = val as { id: string; nom: string };

    const piece = await resoudrePiece(user, texte(e, "fichier"));
    if ("erreur" in piece) return { erreur: piece.erreur };
    // LE FOURNISSEUR, AVANT DE REMPLIR : dans l'annuaire de l'entreprise que la personne voit.
    const fournisseur = await findPartyByName(user.id, texte(e, "fournisseur"));
    if (!fournisseur.ok) return { manque: [fournisseur.error] };

    // LA SOCIÉTÉ — celle que l'ERP inscrira, dite telle quelle.
    const societeId = await companyIdForNew(user.id);
    const societe = await nomSociete(societeId);
    const voulue = texte(e, "societe");
    if (voulue && societe && !replier(societe).includes(replier(voulue)) && !replier(voulue).includes(replier(societe))) {
      return { erreur: `Le bon de commande s'inscrit sur la société sélectionnée dans la barre du haut — aujourd'hui ${societe}. Sélectionnez ${voulue} dans cette barre, puis redemandez.` };
    }

    // LE PASSAGE PAR LES FINANCES — dit avant de confirmer.
    const seuil = (await getAppSettings()).bcValidationThresholdCentre;
    const warnings = [
      validationRequiseBC(montant, seuil)
        ? `Au-dessus du seuil de ${dzd(seuil)} : après le validateur, le bon de commande passe par le centre de validation, puis par la SIGNATURE DES FINANCES.`
        : `Sous le seuil de ${dzd(seuil)} : après le validateur, il passe directement à la SIGNATURE DES FINANCES.`,
      `Société inscrite : ${societe ?? "aucune déterminée — la Direction la rattachera"}${voulue ? "" : " (par défaut, la vôtre)"}.`,
    ];

    return {
      carte: {
        title: `Bon de commande — ${texte(e, "objet")}`,
        fields: champs([
          ["Objet", texte(e, "objet")], ["Fournisseur", fournisseur.name], ["Montant", dzd(montant!)],
          ["Numéro", texte(e, "numero") || null], ["Fichier", piece.nom], ["Validateur", v.nom], ["Société", societe],
        ]),
        warnings,
        libelleBouton: "Créer la demande de validation",
      },
      args: {
        title: texte(e, "objet"), bcTitle: texte(e, "objet"), bcCounterpartyIds: fournisseur.id, bcAmount: String(montant),
        bcReference: texte(e, "numero") || null, validatorId: v.id, description: texte(e, "description") || null,
        fichier: JSON.stringify([piece.id]),
      },
    };
  },

  async executer(a, user) {
    const fichiers = await fichiersDepuisDrive(user, idsDe(a.fichier));
    if (!Array.isArray(fichiers) || !fichiers[0]) return { ok: false, error: Array.isArray(fichiers) ? "Le fichier du bon de commande est introuvable." : fichiers.erreur };
    const fd = new FormData();
    fd.set("objectKind", "BON_DE_COMMANDE");
    fd.set("bcSource", "ORDINATEUR");
    for (const cle of ["title", "bcTitle", "bcCounterpartyIds", "bcAmount", "bcReference", "validatorId", "description"]) if (a[cle]) fd.set(cle, a[cle]!);
    fd.set("bcFile", fichiers[0]);
    const r = await createValidationRequest(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande de validation a été refusée." };
    return { ok: true, message: r.message ?? "Demande de validation créée : le validateur est prévenu.", link: "/validations", revalidate: ["/validations"] };
  },
};
