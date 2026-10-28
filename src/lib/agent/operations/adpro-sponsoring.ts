import { prisma } from "@/lib/prisma";
import { scopeSponsoring, userCan } from "@/lib/rbac";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import { getAppSettings } from "@/lib/settings";
import { porteDgRequise } from "@/lib/seuils/ad-pro";
import { PRIORITY, SPONSORING_NATURE, SPONSORING_TYPES } from "@/lib/labels";
import { champs, dzd, liste, nombre, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive, idsDe, resoudrePieces } from "./pieces";
import { lireMedecins, replier, valeurCommune } from "./annuaire-medical";
import { avertissementBudget } from "./budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CRÉER UNE DEMANDE DE SPONSORING — de bout en bout, par la même action que l'écran.
 *
 * Ce que l'opération fait AVANT de remplir :
 *   • elle nomme ce qui manque (les champs que la Direction a rendus obligatoires, dans l'action
 *     `createSponsoring`) — l'agent les demande UN PAR UN ;
 *   • elle PRÉ-REMPLIT ce qui se lit : la spécialité et la wilaya des médecins reconnus dans
 *     l'annuaire médical — celui que la personne peut voir (`scopeMedicalDoctors`) ;
 *   • elle exige la PIÈCE : la demande du médecin, scannée en PDF ou Word, déjà dans le Drive ou
 *     glissée dans la conversation ;
 *   • elle cherche un DOUBLON parmi les demandes que la personne voit (même institution, six mois) ;
 *   • elle dit si le montant franchit le SEUIL du Directeur Général.
 *
 * Le BUDGET ne se contrôle pas ici, et c'est la règle de l'ERP, pas un oubli : une demande de
 * sponsoring n'engage pas d'argent ; la Direction l'accorde poste par poste après la
 * pré-validation de la tenue. La carte le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FORMATS_DEMANDE = /\.(pdf|doc|docx)$/i;
const NATURES: Record<string, "DIRECT" | "INDIRECT"> = { direct: "DIRECT", indirect: "INDIRECT" };
const IMPORTANCES: Record<string, string> = { basse: "LOW", faible: "LOW", moyenne: "MEDIUM", normale: "MEDIUM", haute: "HIGH", elevee: "HIGH", "élevée": "HIGH", critique: "CRITICAL" };

function typeConnu(v: string): string | null {
  return SPONSORING_TYPES.find((t) => replier(t) === replier(v)) ?? SPONSORING_TYPES.find((t) => replier(t).startsWith(replier(v)) && v.length >= 4) ?? null;
}

export const SPONSORING_CREATION: OperationIA = {
  nom: "preparer_sponsoring",
  module: "SPONSORING",
  libelle: "Demande de sponsoring préparée",
  description:
    "PRÉPARE une nouvelle demande de SPONSORING (Ad & Pro), exécutée à la confirmation par la même action que l'écran. "
    + "Appelle-la dès que tu as quelques éléments : elle répond `manque` avec ce qu'il faut encore demander — pose alors UNE seule question, la première. "
    + "Elle pré-remplit la spécialité et la wilaya depuis l'annuaire médical, cherche les doublons et dit le seuil du Directeur Général. "
    + "La demande du médecin (scan PDF ou Word) est obligatoire : un fichier du Drive ou glissé dans la conversation (son nom ou son identifiant).",
  schema: {
    type: "object",
    properties: {
      institution: { type: "string", description: "Institution / association bénéficiaire." },
      medecins: { type: "string", description: "Le ou les médecins concernés (noms séparés par des virgules)." },
      produits: { type: "string", description: "Le ou les produits concernés." },
      ville: { type: "string", description: "Ville (wilaya)." },
      specialite: { type: "string", description: "Spécialité médicale." },
      type: { type: "string", description: `Type : ${SPONSORING_TYPES.join(", ")}.` },
      nature: { type: "string", enum: ["direct", "indirect"], description: "Direct (versé à l'association) ou indirect (prise en charge de prestations / de médecins)." },
      montantDemande: { type: "number", description: "Sponsoring demandé par le médecin, en DZD." },
      montantSuggere: { type: "number", description: "Sponsoring suggéré par le délégué, en DZD." },
      importance: { type: "string", enum: ["basse", "moyenne", "haute", "critique"], description: "Importance stratégique." },
      description: { type: "string" },
      appreciation: { type: "string", description: "Appréciation personnelle / recommandation." },
      demandeMedecin: { type: "string", description: "La demande du médecin : nom ou identifiant du fichier (PDF ou Word) — plusieurs possibles, séparés par des virgules." },
      annexes: { type: "string", description: "Autres pièces (programme, liste de participants, devis…) : noms ou identifiants." },
    },
  },
  ouverte: (u) => userCan(u, "SPONSORING", "CREATE"),

  async proposer(e, user): Promise<PropositionOperation> {
    const institution = texte(e, "institution");
    const nomsMedecins = liste(e, "medecins");
    const produits = liste(e, "produits");
    const { connus, inconnus, ambigus } = nomsMedecins.length ? await lireMedecins(user, nomsMedecins) : { connus: [], inconnus: [], ambigus: [] };
    if (ambigus.length) {
      return { manque: ambigus.map((a) => `quel médecin pour « ${a.nom} » : ${a.candidats.join(", ")}`) };
    }

    // PRÉ-REMPLISSAGE : ce que l'annuaire dit, quand il le dit d'une seule voix.
    const specialite = texte(e, "specialite") || valeurCommune(connus.map((m) => m.specialite));
    const ville = texte(e, "ville") || valeurCommune(connus.map((m) => m.wilaya));
    const prerempli = [
      !texte(e, "specialite") && specialite ? "spécialité" : null,
      !texte(e, "ville") && ville ? "ville" : null,
    ].filter(Boolean);

    const type = texte(e, "type") ? typeConnu(texte(e, "type")) : null;
    const nature = NATURES[replier(texte(e, "nature"))] ?? null;
    const importance = IMPORTANCES[replier(texte(e, "importance"))] ?? (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(texte(e, "importance")) ? texte(e, "importance") : null);
    const montantDemande = nombre(e, "montantDemande");
    const montantSuggere = nombre(e, "montantSuggere");
    const refsDemande = liste(e, "demandeMedecin");

    const manque = [
      !institution ? "l'institution ou l'association bénéficiaire" : null,
      !nomsMedecins.length ? "le ou les médecins concernés" : null,
      !produits.length ? "le ou les produits concernés" : null,
      !ville ? "la ville (wilaya)" : null,
      !specialite ? "la spécialité" : null,
      !type ? `le type (${SPONSORING_TYPES.join(", ")})` : null,
      !nature ? "la nature : direct (versé à l'association) ou indirect (prise en charge)" : null,
      montantDemande == null ? "le sponsoring demandé par le médecin (DZD)" : null,
      montantSuggere == null ? "le sponsoring que vous suggérez (DZD)" : null,
      !importance ? "l'importance stratégique (basse, moyenne, haute, critique)" : null,
      !refsDemande.length ? "la demande du médecin, scannée (PDF ou Word) : glissez-la dans la conversation ou nommez le fichier du Drive" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) {
      return { manque, ...(prerempli.length ? { precision: `Déjà déduit de l'annuaire médical : ${prerempli.join(", ")}.` } : {}) };
    }
    if ((montantDemande ?? 0) < 0 || (montantSuggere ?? 0) < 0) return { erreur: "Un montant de sponsoring ne peut pas être négatif." };

    // LA PIÈCE EXIGÉE — visible par la personne, au bon format.
    const demandes = await resoudrePieces(user, refsDemande);
    if ("erreur" in demandes) return { erreur: demandes.erreur };
    const horsFormat = demandes.filter((p) => !FORMATS_DEMANDE.test(p.nom));
    if (horsFormat.length) return { erreur: `La demande du médecin doit être un scan PDF ou un Word (.pdf, .doc, .docx) — reçu : ${horsFormat.map((p) => p.nom).join(", ")}.` };
    const annexes = await resoudrePieces(user, liste(e, "annexes"));
    if ("erreur" in annexes) return { erreur: annexes.erreur };

    // LES CONTRÔLES AVANT DE REMPLIR.
    const warnings: string[] = [];
    const depuis = new Date(Date.now() - 183 * 24 * 3600 * 1000);
    const proches = await prisma.sponsoringRequest.findMany({
      where: { AND: [scopeSponsoring(user), { institution: { equals: institution, mode: "insensitive" } }, { createdAt: { gte: depuis } }] },
      select: { reference: true, createdAt: true, doctor: true },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    if (proches.length) {
      warnings.push(`Doublon possible : ${proches.map((p) => `${p.reference} du ${p.createdAt.toLocaleDateString("fr-FR")}${p.doctor ? ` (${p.doctor})` : ""}`).join(" ; ")} — même institution, moins de six mois.`);
    }
    const seuil = (await getAppSettings()).adProDgThreshold;
    if (porteDgRequise(montantSuggere, seuil)) warnings.push(`Au-delà du seuil de ${dzd(seuil)} : le Directeur Général validera aussi.`);
    if (inconnus.length) warnings.push(`Hors annuaire médical (saisis tels quels) : ${inconnus.join(", ")}.`);
    if (prerempli.length) warnings.push(`Pré-rempli depuis l'annuaire médical : ${prerempli.join(", ")} — vérifiez.`);
    warnings.push(await avertissementBudget(user, montantSuggere));
    warnings.push("Le sponsoring devient le premier POSTE de la demande ; les autres postes s'ajoutent après la pré-validation de la tenue. Le budget est accordé ensuite par la Direction.");
    warnings.push("L'original de la demande du médecin doit être déposé au bureau du secrétariat.");

    return {
      carte: {
        title: `Demande de sponsoring — ${institution}`,
        fields: champs([
          ["Institution", institution],
          ["Médecin(s)", [...connus.map((m) => m.nom), ...inconnus].join(", ")],
          ["Produit(s)", produits.join(", ")],
          ["Ville", ville],
          ["Spécialité", specialite],
          ["Type", type],
          ["Nature", nature ? SPONSORING_NATURE[nature] : null],
          ["Demandé par le médecin", dzd(montantDemande!)],
          ["Suggéré", dzd(montantSuggere!)],
          ["Importance", importance ? PRIORITY[importance]?.label ?? importance : null],
          ["Demande du médecin", demandes.map((p) => p.nom).join(", ")],
          ["Autres pièces", annexes.length ? annexes.map((p) => p.nom).join(", ") : null],
          ["Description", texte(e, "description") || null],
        ]),
        warnings,
      },
      args: {
        institution,
        medecinsAnnuaire: JSON.stringify(connus.map((m) => m.nom)),
        medecinsHorsAnnuaire: inconnus.join("\n") || null,
        produits: JSON.stringify(produits),
        ville, specialite, type, nature, importance,
        montantDemande: String(montantDemande), montantSuggere: String(montantSuggere),
        description: texte(e, "description") || null,
        appreciation: texte(e, "appreciation") || null,
        demandes: JSON.stringify(demandes.map((p) => p.id)),
        annexes: JSON.stringify(annexes.map((p) => p.id)),
      },
    };
  },

  async executer(a, user) {
    const demandes = await fichiersDepuisDrive(user, idsDe(a.demandes));
    if (!Array.isArray(demandes)) return { ok: false, error: demandes.erreur };
    const annexes = await fichiersDepuisDrive(user, idsDe(a.annexes));
    if (!Array.isArray(annexes)) return { ok: false, error: annexes.erreur };
    const fd = new FormData();
    fd.set("institution", a.institution ?? "");
    for (const n of idsDe(a.medecinsAnnuaire)) fd.append("doctorIds", n);
    if (a.medecinsHorsAnnuaire) fd.set("doctorHorsAnnuaire", a.medecinsHorsAnnuaire);
    for (const p of idsDe(a.produits)) fd.append("productIds", p);
    for (const [cle, champ] of [["city", "ville"], ["specialty", "specialite"], ["type", "type"], ["nature", "nature"], ["strategicImportance", "importance"],
      ["amountRequested", "montantDemande"], ["amountProposed", "montantSuggere"], ["description", "description"], ["comments", "appreciation"]] as const) {
      if (a[champ]) fd.set(cle, a[champ]!);
    }
    for (const f of demandes) fd.append("files", f);
    for (const f of annexes) fd.append("annexes", f);
    const r = await createSponsoring(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande a été refusée." };
    return {
      ok: true,
      message: r.message ?? "Demande de sponsoring créée : elle part dans son circuit de validation.",
      ...(r.id ? { link: `/sponsoring/${r.id}` } : {}),
      revalidate: ["/sponsoring", "/ad-pro"],
    };
  },
};
