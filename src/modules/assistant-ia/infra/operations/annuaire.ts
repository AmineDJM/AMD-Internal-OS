import { prisma } from "@/lib/prisma";
import { peutAnnuaire, userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { appliquerLotAnnuaire, fusionnerEtablissementsAnnuaire } from "@/lib/actions/fournisseurs-annuaire-actions";
import { CHAMPS_LOT, type CibleLot, type GroupeFusion, type LigneLot } from "@/lib/annuaires/lot";
import { annulerGeste, gestesDeLAssistant, planDAnnulation } from "@/platform/ia/hors-requete";
import { texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { cleDeDoublon, motsDuNom, plier } from "../../domaine/annuaire/analyse";
import { phraseAnnulation } from "../../domaine/terrain/oral";
import { porteeMedecins, voitAnnuaire, voitEtablissements } from "../annuaire/lectures";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TENIR L'ANNUAIRE (lot T2, décision 0051) — trois gestes typés, une carte chacun, exécutés par l'ERP.
 *
 * Mesuré au banc (02/11, 2 tâches réussies sur 19) : « mets à jour le téléphone du Dr Karima BENSALEM » finissait sur
 * « Dr Karima BENSALEM n'est pas dans votre périmètre » (le nom entier ne se trouvait pas), « l'adresse de la pharmacie
 * El Amel » sur « quel est son identifiant ? » (aucune entité établissement), un Excel de 3 lignes sur rien du tout, et
 * « fusionne les doublons » sur un tour épuisé (150 000 jetons). La robustesse vient de l'architecture :
 *
 *   • `maj_annuaire` — UNE ou PLUSIEURS fiches (médecins, pharmacies, établissements) : chaque fiche est RÉSOLUE par les
 *     mots de son nom dans la portée de la personne (le panel du délégué), chaque champ VALIDÉ, la valeur d'avant LUE :
 *     la carte montre « avant → après » ligne par ligne, les fiches introuvables, les homonymes. Confirmée : l'action
 *     `appliquerLotAnnuaire` — un SEUL geste, annulable d'un coup (tout le lot) ; chaque ligne rejugée par l'écran.
 *   • `fusionner_doublons_annuaire` — des fiches nommées, ou TOUTES les paires d'une wilaya (« nettoie les doublons
 *     des pharmacies d'Oran ») : rapprochement déterministe (`cleDeDoublon`), la fiche la plus complète gardée, les
 *     coordonnées manquantes complétées, praticiens et secteurs déplacés, les autres DÉSACTIVÉES. Un geste, annulable.
 *   • `annuler_mon_action` — « annule cette mise à jour » : la carte montre ce que l'annulation défera (le plan
 *     du journal des effets) ; la personne confirme ; `annulerGeste` défait effet par effet (« rétablir » le refait).
 *
 * Un délégué hors secteur ne voit pas la fiche d'un autre panel : elle est « introuvable » pour lui, et l'action la
 * refuserait de toute façon (`canAccessEntity`). Les deux premiers gestes entrent aussi dans les MISSIONS (moteur des
 * travaux) pour les lots longs : un geste par lot, approuvé avec le plan.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CHAMPS_MEDECIN = Object.keys(CHAMPS_LOT.medecin);
const CHAMPS_ETAB = Object.keys(CHAMPS_LOT.etablissement);
const CHAMPS_FOURN = Object.keys(CHAMPS_LOT.fournisseur);
const LIBELLE_CHAMP: Record<string, string> = {
  telephone: "téléphone", email: "e-mail", contact: "contact", site: "site web", ville: "ville", pays: "pays", adresse: "adresse", specialite: "spécialité", etablissement: "établissement", wilaya: "wilaya", region: "région", nom: "nom", notes: "notes", commentaires: "commentaires", type: "type",
};
const COLONNE: Record<string, string> = { telephone: "phone", email: "email", adresse: "address", wilaya: "wilaya", region: "region", nom: "name", notes: "notes", commentaires: "comments", type: "type" };

const peutModifierAnnuaire = (u: CurrentUser) =>
  (voitAnnuaire(u) && (userCan(u, "MEDICAL", "UPDATE") || peutAnnuaire(u, "MEDECINS", "UPDATE") || peutAnnuaire(u, "ETABLISSEMENTS", "UPDATE") || peutAnnuaire(u, "PHARMACIENS", "UPDATE")))
  // L'annuaire des FOURNISSEURS Regulatory (les fabricants) : la règle de son écran, `peutAnnuaire(FOURNISSEURS)`.
  || peutAnnuaire(u, "FOURNISSEURS", "UPDATE");

interface FicheTrouvee { cible: CibleLot; id: string; nom: string; actuel: Record<string, string | null> }

/** Les fiches qu'un nom désigne, dans ce que la personne VOIT — par les mots du nom (titres retirés, ordre libre). */
async function trouverFiches(u: CurrentUser, nom: string, cible: CibleLot | null): Promise<FicheTrouvee[]> {
  const mots = motsDuNom(nom.replace(/\b(pharmacie|officine)\b/gi, " ")).filter(Boolean);
  const motsEtab = motsDuNom(nom);
  if (!mots.length && !motsEtab.length) return [];
  const out: FicheTrouvee[] = [];
  if ((cible === null || cible === "medecin") && mots.length) {
    const ds = await prisma.medicalDoctor.findMany({
      where: { AND: [porteeMedecins(u), ...motsDuNom(nom).map((m) => ({ name: { contains: m, mode: "insensitive" as const } }))] },
      select: { id: true, name: true, phone: true, email: true, wilaya: true, region: true, comments: true, specialty: true, institution: true, specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } } },
      take: 6,
    });
    for (const d of ds) out.push({ cible: "medecin", id: d.id, nom: d.name, actuel: { telephone: d.phone, email: d.email, wilaya: d.wilaya, region: d.region, commentaires: d.comments, nom: d.name, specialite: d.specialtyRef?.name ?? d.specialty, etablissement: d.institutionRef?.name ?? d.institution } });
  }
  if ((cible === null || cible === "etablissement") && voitEtablissements(u)) {
    const motsE = mots.length ? mots : motsEtab;
    const es = await prisma.medicalInstitution.findMany({
      where: { isActive: true, AND: motsE.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) },
      select: { id: true, name: true, phone: true, email: true, address: true, wilaya: true, region: true, notes: true, type: true },
      take: 6,
    });
    for (const e of es) out.push({ cible: "etablissement", id: e.id, nom: e.name, actuel: { telephone: e.phone, email: e.email, adresse: e.address, wilaya: e.wilaya, region: e.region, notes: e.notes, nom: e.name, type: e.type } });
  }
  if ((cible === null || cible === "fournisseur") && peutAnnuaire(u, "FOURNISSEURS", "VIEW") && motsEtab.length) {
    const fs = await prisma.supplier.findMany({
      where: { AND: motsEtab.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) },
      select: { id: true, name: true, phone: true, contactEmail: true, contactName: true, website: true, address: true, city: true, country: true, notes: true },
      take: 6,
    });
    for (const f of fs) out.push({ cible: "fournisseur", id: f.id, nom: f.name, actuel: { telephone: f.phone, email: f.contactEmail, contact: f.contactName, site: f.website, adresse: f.address, ville: f.city, pays: f.country, nom: f.name, notes: f.notes } });
  }
  // Un nom EXACT tranche entre homonymes partiels (« Pharmacie Ibn Sina » face à « Pharmacie Ibn Sina 2 »).
  const exacts = out.filter((f) => plier(f.nom) === plier(nom.replace(/^(le |la )?(dr\.?|docteur|pr\.?) /i, "")));
  return exacts.length === 1 ? exacts : out;
}

const egal = (a: string | null | undefined, b: string | null | undefined) => plier(a ?? "").replace(/\s+/g, "") === plier(b ?? "").replace(/\s+/g, "");

interface Changement { fiche: string; quoi?: string; champ: string; valeur: string }
function lireChangements(e: Record<string, unknown>): Changement[] {
  const brut = Array.isArray(e.changements) ? e.changements : [];
  const unique = texte(e, "fiche") && texte(e, "champ") ? [{ fiche: texte(e, "fiche"), quoi: texte(e, "quoi"), champ: texte(e, "champ"), valeur: texte(e, "valeur") }] : [];
  return [...brut, ...unique].filter((c): c is Changement => !!c && typeof c === "object" && typeof (c as Changement).fiche === "string" && typeof (c as Changement).champ === "string")
    .map((c) => ({ fiche: c.fiche.trim(), quoi: typeof c.quoi === "string" ? c.quoi : undefined, champ: plier(c.champ).replace(/[^a-z]/g, "").replace(/^phone|^tel.*/, "telephone").replace(/^mail$|^courriel$/, "email").replace(/^address$/, "adresse").replace(/^(siteweb|siteinternet|website|web)$/, "site").replace(/^(pays|country)$/, "pays"), valeur: String(c.valeur ?? "").trim() }))
    .slice(0, 500);
}

export const MAJ_ANNUAIRE: OperationIA = {
  nom: "maj_annuaire",
  module: "MEDICAL",
  libelle: "Annuaire mis à jour",
  description:
    "CORRIGER OU COMPLÉTER L'ANNUAIRE : une ou plusieurs fiches de médecins, pharmacies, établissements ou fournisseurs (fabricants) — "
    + "téléphone, e-mail, adresse, spécialité, établissement de rattachement, wilaya, région, nom, site web, contact, pays. Une ligne par changement { fiche (le nom tel que dit : « Dr Karima "
    + "BENSALEM », « Pharmacie El Amel »), champ, valeur }. Depuis un Excel ou une liste : lis d'abord le fichier (lire_tableur), puis passe "
    + "TOUTES ses lignes ici en une fois. Le serveur trouve chaque fiche dans l'annuaire de la personne, montre avant → après, signale les "
    + "introuvables ; UNE carte, annulable d'un coup. N'invente aucune valeur ; ne demande jamais d'identifiant.",
  schema: {
    type: "object",
    properties: {
      changements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fiche: { type: "string", description: "Nom du médecin ou de l'établissement, tel que dit." },
            quoi: { type: "string", enum: ["medecin", "etablissement", "fournisseur"], description: "Facultatif : lève une ambiguïté." },
            champ: { type: "string", enum: [...new Set([...CHAMPS_MEDECIN, ...CHAMPS_ETAB, ...CHAMPS_FOURN])] },
            valeur: { type: "string" },
          },
          required: ["fiche", "champ", "valeur"],
        },
      },
    },
    required: ["changements"],
  },
  ouverte: peutModifierAnnuaire,
  proposer: async (entree, user): Promise<PropositionOperation> => {
    const changements = lireChangements(entree);
    if (!changements.length) return { manque: ["la fiche à modifier, le champ et la nouvelle valeur"] };
    const parFiche = new Map<string, { f: FicheTrouvee; champs: Record<string, string>; lignes: string[] }>();
    const introuvables: string[] = [];
    const ambigus: { nom: string; candidats: string[] }[] = [];
    const refuses: string[] = [];
    for (const c of changements) {
      const cible: CibleLot | null = c.quoi === "medecin" || c.quoi === "etablissement" || c.quoi === "fournisseur" ? c.quoi
        : c.champ === "site" || c.champ === "pays" || c.champ === "contact" ? "fournisseur"
        : c.champ === "adresse" || c.champ === "type" || c.champ === "notes" ? "etablissement" : c.champ === "specialite" || c.champ === "etablissement" || c.champ === "commentaires" ? "medecin" : null;
      const trouvees = await trouverFiches(user, c.fiche, cible);
      if (!trouvees.length) { introuvables.push(c.fiche); continue; }
      if (trouvees.length > 1) { ambigus.push({ nom: c.fiche, candidats: trouvees.map((t) => t.nom) }); continue; }
      const f = trouvees[0]!;
      const permis = f.cible === "medecin" ? CHAMPS_MEDECIN : f.cible === "fournisseur" ? CHAMPS_FOURN : CHAMPS_ETAB;
      if (!permis.includes(c.champ)) { refuses.push(`${f.nom} : « ${c.champ} » ne se modifie pas sur une fiche ${f.cible === "medecin" ? "de médecin" : f.cible === "fournisseur" ? "de fournisseur" : "d'établissement"}`); continue; }
      if (egal(f.actuel[c.champ], c.valeur)) continue;
      const p = parFiche.get(f.id) ?? { f, champs: {}, lignes: [] };
      p.champs[c.champ] = c.valeur;
      p.lignes.push(`${LIBELLE_CHAMP[c.champ] ?? c.champ} : ${f.actuel[c.champ] || "(vide)"} → ${c.valeur || "(effacé)"}`);
      parFiche.set(f.id, p);
    }
    // Une seule fiche visée, et ambiguë : UNE question, avec les candidats (jamais un choix en silence).
    if (!parFiche.size && ambigus.length === 1 && changements.length === 1) {
      return { manque: [`laquelle de ces fiches : ${ambigus[0]!.candidats.join(" ; ")}`], precision: "Plusieurs fiches portent ce nom dans ton annuaire." };
    }
    if (!parFiche.size) {
      const raisons = [
        ...(introuvables.length ? [`introuvable(s) dans votre annuaire : ${introuvables.join(", ")}`] : []),
        ...(ambigus.length ? [`homonymes à préciser : ${ambigus.map((a) => `${a.nom} (${a.candidats.join(" / ")})`).join(" ; ")}`] : []),
        ...refuses,
      ];
      return { erreur: raisons.length ? `Rien à modifier — ${raisons.join(" ; ")}.` : "Rien à modifier : les fiches portent déjà ces valeurs." };
    }
    const lignes: LigneLot[] = [...parFiche.values()].map((p) => ({ cible: p.f.cible, id: p.f.id, champs: p.champs }));
    const fiches = [...parFiche.values()];
    return {
      carte: {
        title: fiches.length === 1 ? `Modifier la fiche « ${fiches[0]!.f.nom} »` : `Mettre à jour ${fiches.length} fiches de l'annuaire`,
        fields: fiches.slice(0, 30).map((p) => ({ label: p.f.nom, value: p.lignes.join(" · ") })),
        warnings: [
          ...(fiches.length > 30 ? [`${fiches.length - 30} autre(s) fiche(s) dans le lot, non affichée(s) ici.`] : []),
          ...(introuvables.length ? [`Introuvable(s) dans votre annuaire, non modifiée(s) : ${introuvables.join(", ")}.`] : []),
          ...(ambigus.length ? [`Homonymes, non modifiés (à préciser) : ${ambigus.map((a) => `${a.nom} → ${a.candidats.join(" / ")}`).join(" ; ")}.`] : []),
          ...refuses.map((r) => `${r}.`),
          "Annulable d'un coup : tout le lot revient à ses valeurs d'avant.",
        ],
        libelleBouton: fiches.length === 1 ? "Enregistrer" : `Mettre à jour ${fiches.length} fiches`,
      },
      args: { lignes: JSON.stringify(lignes), introuvables: introuvables.join(", ") || null },
    };
  },
  executer: async (args) => {
    const fd = new FormData();
    fd.set("lignes", args.lignes ?? "[]");
    const r = await appliquerLotAnnuaire(fd);
    if (!r.ok) return { ok: false, error: r.error };
    const c = r.compte!;
    return {
      ok: true,
      message: `${c.faites} fiche(s) mise(s) à jour${c.refusees.length ? ` ; ${c.refusees.length} refusée(s) : ${c.refusees.map((x) => x.raison).slice(0, 5).join(" ; ")}` : ""}${args.introuvables ? ` ; introuvable(s) : ${args.introuvables}` : ""}. Annulable d'un coup.`,
      link: "/medical",
    };
  },
};

/** La fiche gardée d'un groupe : la plus complète (coordonnées, secteurs, praticiens rattachés). */
type Etab = { id: string; name: string; phone: string | null; address: string | null; email: string | null; wilaya: string | null; _count: { sectors: number; doctors: number } };
const score = (e: Etab) => [e.phone, e.address, e.email].filter(Boolean).length + 2 * e._count.sectors + e._count.doctors;

export const FUSION_DOUBLONS: OperationIA = {
  nom: "fusionner_doublons_annuaire",
  module: "MEDICAL",
  libelle: "Doublons de l'annuaire fusionnés",
  description:
    "FUSIONNER LES DOUBLONS de l'annuaire des pharmacies et établissements : soit les fiches NOMMÉES (« les deux fiches Pharmacie Es-Salam »), "
    + "soit TOUTES les paires d'une wilaya (« nettoie les doublons des pharmacies d'Oran »). Le serveur rapproche les fiches (nom sans "
    + "accents ni ponctuation, même wilaya), garde la plus complète, complète ses coordonnées, déplace praticiens et secteurs, désactive les "
    + "autres (jamais supprimées). UNE carte, annulable d'un coup — aussi pour un nettoyage complet : pas besoin de mission.",
  schema: {
    type: "object",
    properties: {
      fiches: { type: "array", items: { type: "string" }, description: "Les noms des fiches en double (facultatif)." },
      wilaya: { type: "string", description: "La wilaya à nettoyer (facultatif)." },
      quoi: { type: "string", enum: ["pharmacie", "etablissement"], description: "Défaut : pharmacie." },
    },
  },
  ouverte: (u) => peutAnnuaire(u, "ETABLISSEMENTS", "UPDATE") || peutAnnuaire(u, "PHARMACIENS", "UPDATE"),
  proposer: async (entree): Promise<PropositionOperation> => {
    const noms = Array.isArray(entree.fiches) ? entree.fiches.map(String).filter(Boolean) : [];
    const w = texte(entree, "wilaya");
    const pharmacie = texte(entree, "quoi") !== "etablissement";
    if (!noms.length && !w) return { manque: ["la wilaya à nettoyer, ou les fiches en double"] };
    const etabs = await prisma.medicalInstitution.findMany({
      where: {
        isActive: true, ...(pharmacie ? { type: "PHARMACIE" } : {}),
        ...(w ? { OR: [{ wilaya: { equals: w, mode: "insensitive" } }, { city: { equals: w, mode: "insensitive" } }] } : {}),
        ...(noms.length ? { OR: noms.map((n) => ({ AND: motsDuNom(n.replace(/\b(pharmacie)\b/gi, " ")).map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) })) } : {}),
      },
      select: { id: true, name: true, phone: true, address: true, email: true, wilaya: true, _count: { select: { sectors: true, doctors: true } } },
      take: 2_000,
    });
    const groupes = new Map<string, Etab[]>();
    for (const e of etabs) { const k = cleDeDoublon(e.name, e.wilaya); groupes.set(k, [...(groupes.get(k) ?? []), e]); }
    let doublons = [...groupes.values()].filter((g) => g.length > 1);
    // Deux fiches NOMMÉES par la personne comme doublon, même si leurs noms divergent : elle a tranché.
    if (!doublons.length && noms.length >= 2 && etabs.length >= 2 && etabs.length <= 4) doublons = [etabs];
    if (!doublons.length) return { erreur: `Aucun doublon trouvé${w ? ` à ${w}` : ""}${noms.length ? ` parmi « ${noms.join(" », « ")} »` : ""} (fiches actives${pharmacie ? ", pharmacies" : ""}).` };
    const plan: GroupeFusion[] = [];
    const fields: { label: string; value: string }[] = [];
    for (const g of doublons) {
      const tries = [...g].sort((a, b) => score(b) - score(a));
      const garde = tries[0]!;
      const autres = tries.slice(1);
      plan.push({ garder: garde.id, absorber: autres.map((a) => a.id) });
      const complete = (["phone", "address", "email"] as const).filter((c) => !garde[c] && autres.some((a) => a[c])).map((c) => ({ phone: "téléphone", address: "adresse", email: "e-mail" })[c]);
      fields.push({ label: `Garder « ${garde.name} »`, value: `absorbe ${autres.map((a) => `« ${a.name} »`).join(", ")}${complete.length ? ` — complète : ${complete.join(", ")}` : ""}` });
    }
    return {
      carte: {
        title: doublons.length === 1 ? `Fusionner les doublons de « ${doublons[0]![0]!.name} »` : `Fusionner ${doublons.length} groupes de doublons${w ? ` — ${w}` : ""}`,
        fields: fields.slice(0, 40),
        warnings: [
          "Les fiches absorbées sont désactivées (jamais supprimées) ; praticiens et secteurs passent sur la fiche gardée.",
          "Annulable d'un coup : toutes les fiches reviennent comme avant.",
        ],
        libelleBouton: doublons.length === 1 ? "Fusionner" : `Fusionner ${doublons.length} groupes`,
      },
      args: { groupes: JSON.stringify(plan) },
    };
  },
  executer: async (args) => {
    const fd = new FormData();
    fd.set("groupes", args.groupes ?? "[]");
    const r = await fusionnerEtablissementsAnnuaire(fd);
    return r.ok ? { ok: true, message: `${r.fusionnees} fiche(s) fusionnée(s) dans leur doublon. Annulable d'un coup.`, link: "/medical" } : { ok: false, error: r.error };
  },
};

const RECENT_MS = 30 * 60_000;

export const ANNULER_DERNIERE: OperationIA = {
  nom: "annuler_mon_action",
  module: "ASSISTANT_IA",
  libelle: "Action de l'assistant annulée",
  description:
    "ANNULER ce que l'assistant vient de faire pour la personne (« annule cette mise à jour », « remets comme avant ») : sa carte "
    + "la plus récente, confirmée il y a moins de 30 minutes, ou celle dont `quoi` décrit le libellé. La carte montre ce qui sera défait ; la personne confirme.",
  schema: { type: "object", properties: { quoi: { type: "string", description: "Ce qu'il faut annuler, en quelques mots (facultatif)." } } },
  ouverte: (u) => !u.impersonatedBy,
  proposer: async (entree, user): Promise<PropositionOperation> => {
    const quoi = plier(texte(entree, "quoi"));
    const gestes = (await gestesDeLAssistant(user, { limite: 10 })).filter((g) => !g.annuleLe && Date.now() - new Date(g.quand).getTime() < RECENT_MS);
    const mots = quoi.split(/\W+/).filter((m) => m.length > 3);
    const g = (mots.length ? gestes.find((x) => mots.some((m) => plier(x.libelle).includes(m))) : null) ?? gestes[0];
    if (!g) return { erreur: "Aucune action récente de l'assistant à annuler (moins de 30 minutes)." };
    const plan = await planDAnnulation(g.id, user);
    if ("refus" in plan) return { erreur: plan.refus };
    return {
      carte: {
        title: `Annuler « ${g.libelle} »`,
        fields: plan.details.slice(0, 20).map((d) => ({ label: d.quoi, value: d.issue === "IMPOSSIBLE" ? `impossible : ${d.pourquoi ?? ""}` : "sera défait" })),
        warnings: [plan.resume, "Rétablissable ensuite (« rétablis »)."],
        libelleBouton: "Annuler l'action",
      },
      args: { gesteId: g.id, libelle: g.libelle },
    };
  },
  executer: async (args, user) => {
    const r = await annulerGeste(args.gesteId ?? "", user);
    if ("refus" in r) return { ok: false, error: r.refus };
    return { ok: true, message: phraseAnnulation(args.libelle ?? "l'action", r.details) };
  },
};

export const OPERATIONS_ANNUAIRE: OperationIA[] = [MAJ_ANNUAIRE, FUSION_DOUBLONS, ANNULER_DERNIERE];
