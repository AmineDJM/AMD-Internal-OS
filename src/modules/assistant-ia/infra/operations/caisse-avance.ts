import { userCan } from "@/lib/rbac";
import { confirmPettyCashReceipt, requestPettyCashTopUp, spendFromPettyCash } from "@/lib/actions/petty-cash-actions";
import { canSpendFromFund, LOW_CASH_RATIO } from "@/lib/general-means/continuous-cash";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { caisseDe } from "../caisse-avance";
import { fichiersDepuisDrive, resoudrePiece } from "./pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAISSE D'AVANCE PAR L'ASSISTANT (« moyens généraux », lot T3, décision 0051) — les gestes de la DÉTENTRICE (l'assistante
 * de direction), par les actions EXISTANTES de l'écran (`petty-cash-actions`, réversibles K10a) :
 *
 *   • `depenser_caisse_avance` — une dépense AVEC son justificatif (photo ou PDF du ticket, du Drive ou glissé dans la
 *     conversation) : l'action de l'écran exige la pièce, l'appel générique ne pouvait donc pas la faire. Le fond est
 *     contrôlé AVANT la carte (`canSpendFromFund`, la règle de l'écran), le solde après est montré, le solde bas dit ;
 *   • `demander_rallonge_caisse` — la rallonge, refusée d'avance si une autre attend ;
 *   • `confirmer_reception_caisse` — la remise reçue en main (la somme devient dépensable).
 * Les autres gestes (remettre une somme, trancher une rallonge, clôturer, régler le plan) restent des capacités du registre,
 * sous leurs propres gardes (administration, RH).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Offert à qui a le module « Moyens généraux » ; la détention de la caisse est jugée dans `proposer`, revérifiée par l'action. */
const ouverteCaisse = (u: Parameters<OperationIA["ouverte"]>[0]) => userCan(u, "GENERAL_MEANS", "VIEW");

export const DEPENSE_CAISSE: OperationIA = {
  nom: "depenser_caisse_avance",
  module: "GENERAL_MEANS",
  libelle: "Dépense sur la caisse d'avance préparée",
  description:
    "ENREGISTRE UNE DÉPENSE payée sur la CAISSE D'AVANCE (« moyens généraux », « petite caisse ») AVEC SON JUSTIFICATIF (photo ou PDF du ticket / de la facture). "
    + "Donne `justificatif` (nom ou identifiant du fichier), `libelle` (ce qui a été acheté), `montant` (DZD, celui du ticket). "
    + "Le serveur vérifie que la caisse couvre le montant et montre le solde après ; seule la détentrice de la caisse dépense.",
  schema: {
    type: "object",
    properties: {
      justificatif: { type: "string", description: "Le ticket ou la facture : nom ou identifiant du fichier." },
      libelle: { type: "string", description: "Ce qui a été acheté (« Café et eau — novembre »)." },
      montant: { type: "number", description: "DZD, le total du ticket." },
      notes: { type: "string" },
    },
  },
  ouverte: ouverteCaisse,

  async proposer(e, user): Promise<PropositionOperation> {
    const montant = nombre(e, "montant");
    const manque = [
      !texte(e, "justificatif") ? "le justificatif : la photo ou le PDF du ticket (une dépense sans pièce n'est pas acceptée)" : null,
      !texte(e, "libelle") ? "ce qui a été acheté" : null,
      montant === null ? "le montant du ticket" : null,
    ].filter((x): x is string => !!x);
    if (manque.length) return { manque };
    const c = await caisseDe(user);
    if ("refus" in c) return { erreur: c.refus };
    if (!c.vue.isHolder || !c.vue.cash) return { erreur: `Seule la personne qui détient la caisse y impute des dépenses${c.vue.cash?.holder ? ` (aujourd'hui : ${c.vue.cash.holder})` : ""}.` };
    const fond = c.vue.cash.fund;
    const ok = canSpendFromFund(fond, montant!);
    if (!ok.ok) return { erreur: ok.reason ?? "Dépense impossible." };
    const piece = await resoudrePiece(user, texte(e, "justificatif"));
    if ("erreur" in piece) return { erreur: piece.erreur };
    const apres = fond.remaining - montant!;
    const warnings: string[] = [];
    if (apres < fond.received * LOW_CASH_RATIO) warnings.push(`Après cette dépense, il restera ${dzd(apres)} : moins d'un cinquième de la caisse — pensez à demander une rallonge.`);
    const doublon = c.vue.expenses.find((x) => x.fromPettyCash && x.amount === montant && x.label.toLowerCase() === texte(e, "libelle").toLowerCase());
    if (doublon) warnings.push(`Une dépense identique existe déjà (${doublon.date.slice(0, 10)}, ${dzd(doublon.amount)}) : vérifiez que ce n'est pas un doublon.`);
    return {
      carte: {
        title: `Dépense sur la caisse — ${texte(e, "libelle")}`,
        fields: champs([
          ["Achat", texte(e, "libelle")], ["Montant", dzd(montant!)], ["Justificatif", piece.nom],
          ["Solde de la caisse", `${dzd(fond.remaining)} → ${dzd(apres)}`], ["Notes", texte(e, "notes") || null],
        ]),
        warnings, libelleBouton: "Enregistrer la dépense",
      },
      args: { cashId: c.vue.cash.currentId ?? c.vue.cash.remittances[0]?.id ?? null, label: texte(e, "libelle"), amount: String(montant), notes: texte(e, "notes") || null, piece: piece.id, year: String(c.vue.year) },
    };
  },

  async executer(a, user) {
    const f = await fichiersDepuisDrive(user, a.piece ? [a.piece] : []);
    if (!Array.isArray(f) || !f[0]) return { ok: false, error: Array.isArray(f) ? "Le justificatif est introuvable." : f.erreur };
    const fd = new FormData();
    for (const k of ["cashId", "label", "amount", "notes", "year"]) if (a[k]) fd.set(k, a[k]!);
    fd.append("files", f[0]);
    const r = await spendFromPettyCash(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La dépense n'a pas pu être enregistrée." };
    return { ok: true, message: `${r.message ?? "Dépense enregistrée avec son justificatif."} Annulable en un geste.`, link: "/moyens-generaux", revalidate: ["/moyens-generaux"] };
  },
};

export const RALLONGE_CAISSE: OperationIA = {
  nom: "demander_rallonge_caisse",
  module: "GENERAL_MEANS",
  libelle: "Demande de rallonge de la caisse préparée",
  description: "DEMANDE UNE RALLONGE de la CAISSE D'AVANCE (« moyens généraux ») : `montant` (DZD) et `motif`. Le serveur montre le solde et refuse si une demande attend déjà.",
  schema: { type: "object", properties: { montant: { type: "number" }, motif: { type: "string" } } },
  ouverte: ouverteCaisse,

  async proposer(e, user): Promise<PropositionOperation> {
    const montant = nombre(e, "montant");
    if (montant === null || montant <= 0) return { manque: ["le montant de la rallonge"] };
    const c = await caisseDe(user);
    if ("refus" in c) return { erreur: c.refus };
    if (!c.vue.isHolder || !c.vue.cash) return { erreur: "Seule la personne qui détient la caisse en demande la rallonge." };
    const attente = c.vue.topUps.find((t) => t.status === "PENDING");
    if (attente) return { erreur: `Une demande de rallonge de ${dzd(attente.amountRequested)} attend déjà la décision (depuis le ${attente.createdAt.slice(0, 10)}).` };
    return {
      carte: {
        title: `Rallonge de la caisse — ${dzd(montant)}`,
        fields: champs([["Montant demandé", dzd(montant)], ["Motif", texte(e, "motif") || null], ["Solde actuel", dzd(c.vue.cash.fund.remaining)], ["Décision", "par l'administration (Moyens généraux)"]]),
        warnings: [], libelleBouton: "Demander la rallonge",
      },
      args: { cashId: c.vue.cash.currentId ?? c.vue.cash.remittances[0]?.id ?? null, amount: String(montant), reason: texte(e, "motif") || null },
    };
  },

  async executer(a) {
    const fd = new FormData();
    for (const k of ["cashId", "amount", "reason"]) if (a[k]) fd.set(k, a[k]!);
    const r = await requestPettyCashTopUp(fd);
    return r.ok ? { ok: true, message: `${r.message ?? "Rallonge demandée."} Annulable en un geste.`, link: "/moyens-generaux", revalidate: ["/moyens-generaux"] } : { ok: false, error: r.error ?? "La demande n'a pas pu être envoyée." };
  },
};

export const RECEPTION_CAISSE: OperationIA = {
  nom: "confirmer_reception_caisse",
  module: "GENERAL_MEANS",
  libelle: "Réception de la caisse préparée",
  description: "CONFIRME LA RÉCEPTION d'une somme remise en CAISSE D'AVANCE (« j'ai reçu l'argent de la caisse ») : la somme devient dépensable. Sans montant, la remise en attente la plus ancienne.",
  schema: { type: "object", properties: { montant: { type: "number", description: "Le montant reçu, s'il y a plusieurs remises en attente." } } },
  ouverte: ouverteCaisse,

  async proposer(e, user): Promise<PropositionOperation> {
    const c = await caisseDe(user);
    if ("refus" in c) return { erreur: c.refus };
    const attente = (c.vue.cash?.remittances ?? []).filter((r) => r.status === "ALLOTTED").sort((x, y) => x.remittedAt.localeCompare(y.remittedAt));
    if (!attente.length) return { erreur: "Aucune remise n'attend votre confirmation de réception." };
    const montant = nombre(e, "montant");
    const visees = montant !== null ? attente.filter((r) => r.amount === montant) : attente;
    if (!visees.length) return { erreur: `Aucune remise de ${dzd(montant!)} n'attend de confirmation (en attente : ${attente.map((r) => dzd(r.amount)).join(", ")}).` };
    const r = visees[0]!;
    return {
      carte: {
        title: `Réception de ${dzd(r.amount)} en caisse`,
        fields: champs([["Remise", `${dzd(r.amount)} — remise le ${r.remittedAt.slice(0, 10)}`], ["Solde après réception", dzd((c.vue.cash?.fund.remaining ?? 0) + r.amount)]]),
        warnings: attente.length > 1 && montant === null ? [`${attente.length} remises attendent : la plus ancienne est confirmée.`] : [], libelleBouton: "Confirmer la réception",
      },
      args: { id: r.id },
    };
  },

  async executer(a) {
    const fd = new FormData();
    fd.set("id", a.id!);
    const r = await confirmPettyCashReceipt(fd);
    return r.ok ? { ok: true, message: `${r.message ?? "Réception confirmée."} Annulable en un geste.`, link: "/moyens-generaux", revalidate: ["/moyens-generaux"] } : { ok: false, error: r.error ?? "La réception n'a pas pu être confirmée." };
  },
};
