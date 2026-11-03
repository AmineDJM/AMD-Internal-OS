import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { liste, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { joursJusqua, planDemandesTerrain } from "../../domaine/annuaire/demandes";
import { motsDuNom } from "../../domaine/annuaire/analyse";
import { REFUS_DEMANDE_STOCK } from "@/lib/rbac";
import { DEMANDE_D_ETAT_DE_STOCK, peutLancerDemandeStock } from "./stocks-terrain";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDER AU TERRAIN (lot T2, décision 0052) — « demande à Yanis et à Karim combien de boîtes de Daclavir il reste
 * dans leurs pharmacies, pour vendredi, relance-les et fais-moi un tableau ».
 *
 * Mesuré : aucune de ces phrases n'activait le moteur des travaux (seul « répondre à une demande » ressortait), et un
 * plan écrit à la main par le modèle pour 2 demandes + relance + consolidation est fragile. Ici le PLAN est construit
 * par le code (`planDemandesTerrain`, pur) : une étape DEMANDE par personne (échéance, relance, abandon), puis un
 * LIVRABLE qui consolide les réponses (Excel par défaut). La carte dit à qui, quoi, pour quand ; confirmée, elle VAUT
 * approbation du plan (la personne a vu les étapes) : le travail démarre dans le moteur (suivi « Missions », reprise,
 * arrêt). Le canal est INTERNE : la demande se dépose dans l'espace de la personne sollicitée (J8) — jamais un mail.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une personne désignée par son nom (mots, ordre libre) parmi les comptes actifs — exactement une, jamais soi. */
async function designer(nom: string, moi: string): Promise<{ ok: true; nom: string } | { ok: false; raison: string }> {
  // Une ADRESSE tranche entre homonymes (la règle du moteur des travaux : nom exact ou e-mail).
  if (nom.includes("@")) {
    const u = await prisma.user.findFirst({ where: { isActive: true, email: { equals: nom.trim(), mode: "insensitive" } }, select: { id: true, email: true } });
    if (!u) return { ok: false, raison: `aucun compte actif à l'adresse « ${nom} »` };
    return u.id === moi ? { ok: false, raison: "on ne s'adresse pas une demande à soi-même" } : { ok: true, nom: u.email };
  }
  const mots = motsDuNom(nom);
  if (!mots.length) return { ok: false, raison: `« ${nom} » : nom illisible` };
  const us = await prisma.user.findMany({ where: { isActive: true, AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) }, select: { id: true, name: true }, take: 4 });
  if (!us.length) return { ok: false, raison: `personne de ce nom parmi les comptes actifs : « ${nom} »` };
  if (us.length > 1) return { ok: false, raison: `« ${nom} » désigne plusieurs personnes (${us.map((u) => u.name).join(", ")}) — précisez son e-mail` };
  if (us[0]!.id === moi) return { ok: false, raison: "on ne s'adresse pas une demande à soi-même" };
  return { ok: true, nom: us[0]!.name };
}

export const DEMANDER_AU_TERRAIN: OperationIA = {
  nom: "demander_au_terrain",
  module: "ASSISTANT_IA",
  libelle: "Demande lancée auprès des personnes",
  description:
    "DEMANDER À DES PERSONNES (délégués, collègues) une information et suivre leurs réponses : stocks en pharmacie, retours terrain, "
    + "disponibilités, chiffres. « Demande à Yanis et Karim combien il reste de Daclavir dans leurs pharmacies pour vendredi, relance-les, "
    + "fais-moi un tableau ». Le serveur construit la mission : une demande par personne (déposée dans son espace, canal interne), "
    + "une relance si pas de réponse, puis un livrable consolidé (Excel par défaut). UNE carte ; confirmée, la mission démarre.",
  schema: {
    type: "object",
    properties: {
      destinataires: { type: "array", items: { type: "string" }, description: "Noms (ou e-mails) des personnes à qui demander." },
      question: { type: "string", description: "Ce qu'on leur demande, en une ou deux phrases." },
      echeance: { type: "string", description: "Pour quand : AAAA-MM-JJ, ou un jour (« vendredi »). Défaut : 3 jours." },
      relanceJours: { type: "number", description: "Relancer après N jours sans réponse (défaut : 2, ou 1 si l'échéance est plus courte)." },
      consolider: { type: "string", enum: ["xlsx", "docx", "md"], description: "Le livrable qui consolide les réponses (défaut xlsx)." },
      titre: { type: "string" },
    },
    required: ["destinataires", "question"],
  },
  ouverte: (u: CurrentUser) => !u.impersonatedBy,
  proposer: async (entree, user): Promise<PropositionOperation> => {
    const noms = liste(entree, "destinataires");
    const question = texte(entree, "question");
    if (!noms.length) return { manque: ["à qui faut-il demander"] };
    if (!question) return { manque: ["ce qu'il faut leur demander"] };
    // T2 bis (décision 0062) : demander un état de stock à d'autres, c'est la demande formelle — même règle, même refus.
    if (DEMANDE_D_ETAT_DE_STOCK.test(question) && !peutLancerDemandeStock(user)) return { erreur: REFUS_DEMANDE_STOCK };
    const trouves: string[] = [];
    const fautes: string[] = [];
    for (const n of noms.slice(0, 15)) {
      const r = await designer(n, user.id);
      if (r.ok) { if (!trouves.includes(r.nom)) trouves.push(r.nom); } else fautes.push(r.raison);
    }
    if (!trouves.length) return { erreur: `Personne à solliciter : ${fautes.join(" ; ")}.` };
    const jours = joursJusqua(texte(entree, "echeance"), new Date()) ?? 3;
    const relance = nombre(entree, "relanceJours");
    const format = (["xlsx", "docx", "md"] as const).find((f) => f === texte(entree, "consolider")) ?? "xlsx";
    const plan = planDemandesTerrain({ destinataires: trouves, question, jours, relanceJours: relance, format, titre: texte(entree, "titre") || null });
    return {
      carte: {
        title: `Demander à ${trouves.length === 1 ? trouves[0] : `${trouves.length} personnes`}`,
        fields: [
          { label: "À", value: trouves.join(", ") },
          { label: "Question", value: question },
          { label: "Réponse attendue", value: `sous ${jours} jour(s)` },
          { label: "Relance", value: plan.relanceJours < jours ? `après ${plan.relanceJours} jour(s) sans réponse` : "à l'échéance" },
          { label: "Consolidation", value: format === "xlsx" ? "tableau Excel des réponses" : format === "docx" ? "document Word des réponses" : "synthèse dans la conversation" },
        ],
        warnings: [
          ...(fautes.length ? [`Non sollicité(s) : ${fautes.join(" ; ")}.`] : []),
          "Confirmer lance la mission (suivi dans « Missions ») : chaque demande se dépose dans l'espace de la personne (canal interne). Arrêtable à tout moment.",
        ],
        libelleBouton: "Lancer la demande",
      },
      args: { plan: JSON.stringify(plan.plan) },
    };
  },
  executer: async (args, user) => {
    // Import paresseux : le moteur des travaux importe le registre des opérations (cycle évité).
    const { approuverTravail, PERSONA_ASSISTANT_IA, proposerTravail } = await import("../travaux");
    let plan: unknown;
    try { plan = JSON.parse(args.plan ?? "null"); } catch { return { ok: false, error: "Plan illisible : relancez la demande." }; }
    const p = await proposerTravail(user.id, PERSONA_ASSISTANT_IA, plan, { origine: "carte demander_au_terrain" });
    if (!p.ok) return { ok: false, error: p.fautes.join(" ") };
    // La carte confirmée VAUT approbation : la personne a vu à qui, quoi, pour quand, la relance et le livrable.
    const a = await approuverTravail(p.travailId, user.id, PERSONA_ASSISTANT_IA);
    return a.ok ? { ok: true, message: "Demande lancée : la mission suit les réponses, relance et consolidera.", link: "/ia" } : { ok: false, error: a.erreur };
  },
};
