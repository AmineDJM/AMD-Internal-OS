import type { PowerTool } from "@/platform/ia/outil";
import { aVueGlobale } from "@/platform/in-process/sandbox";
import { RESUME_POUR_PLANNER, SOURCES, listerEvenementsRecus, rattacherEvenement, resumeIngestion } from "@/platform/in-process/events/ingestion";

/**
 * LES FAITS EXTERNES DANS LA CONVERSATION (mandat 5 §37).
 *
 * `inbound_events` LIT ce que l'ingestion universelle a reçu (signatures, commandes SAP, appels
 * d'offres PCH, transactions CRM, webhooks génériques), avec le statut d'association de chacun :
 * accepté, à vérifier (candidats et scores), sans association, rejeté, doublon. Vue globale : ces
 * faits touchent à des dossiers qui ne sont pas forcément ceux de la personne.
 *
 * `attach_inbound_event` est le GESTE DE PERSONNE qui lève un doute : rattacher un fait à une
 * entité. L'agent en est exclu à la compilation (`policy/guard.ts`) — un document lu par une
 * mission ne peut pas décider à qui appartient une signature.
 */
const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");

export const INBOUND_TOOLS: PowerTool[] = [
  {
    def: {
      name: "inbound_events",
      description:
        "WEBHOOKS ET FAITS EXTERNES REÇUS (« quels événements sont arrivés par webhook ? », « qu'a-t-on reçu de DocuSign / SAP / HubSpot ? ») : l'ingestion universelle des systèmes externes — signatures DocuSign / e-signature, commandes et factures SAP, appels d'offres PCH, "
        + "transactions et contacts HubSpot, données IQVIA, faits génériques. Pour chaque fait : source, type canonique, quand, statut d'association "
        + "(ACCEPTED rattaché · A_VERIFIER avec ses candidats et leurs scores · SANS_ASSOCIATION · REJECTED · DUPLICATE), références rattachées, résumé. "
        + "À utiliser pour « qu'est-ce qui est arrivé de DocuSign ? », « la commande SAP est-elle passée ? », « quels faits restent à vérifier ? ». "
        + `Types du catalogue : ${RESUME_POUR_PLANNER}.`,
      input_schema: {
        type: "object",
        properties: {
          source: { type: "string", enum: [...SOURCES], description: "Filtrer sur une source. Vide = toutes." },
          statut: { type: "string", enum: ["ACCEPTED", "A_VERIFIER", "SANS_ASSOCIATION", "REJECTED", "DUPLICATE"], description: "Filtrer sur un statut. Vide = tous (le plus sûr pour « qu'est-ce qui est arrivé ? »)." },
          heures: { type: "integer", description: "Fenêtre en heures (défaut 72)." },
          limite: { type: "integer", description: "Nombre de faits (défaut 30, max 100)." },
        },
      },
    },
    allowed: (u) => aVueGlobale(u),
    label: "Faits externes reçus",
    run: async (input) => {
      const heures = typeof input.heures === "number" && input.heures > 0 ? Math.min(input.heures, 24 * 90) : 72;
      const depuis = new Date(Date.now() - heures * 3600_000);
      const [faits, resume] = await Promise.all([
        listerEvenementsRecus({ source: str(input, "source") || null, statut: str(input, "statut") || null, depuis, limite: typeof input.limite === "number" ? input.limite : 30 }),
        resumeIngestion(depuis),
      ]);
      const totalFenetre = Object.values(resume).reduce((a, b) => a + b, 0);
      const source = str(input, "source") || null; const statut = str(input, "statut") || null;
      return JSON.stringify({
        fenetreHeures: heures, parStatut: resume, total: faits.length,
        // Le filtre a tout caché alors que la fenêtre porte des faits : le DIRE, sinon le modèle conclut « rien reçu ».
        ...(faits.length === 0 && totalFenetre > 0 ? { attention: `aucun fait ne répond aux filtres (${[source ? `source ${source}` : null, statut ? `statut ${statut}` : null].filter(Boolean).join(", ") || "aucun filtre"}), mais ${totalFenetre} fait(s) sont arrivés dans la fenêtre : relancer sans filtre.` } : {}),
        aVerifier: faits.filter((f) => f.statut === "A_VERIFIER").length,
        faits: faits.map((f) => ({ id: f.id, source: f.source, type: f.type, recuLe: f.recuLe, statut: f.statut, confiance: f.confiance, refs: f.refs, resume: f.resume, ...(f.candidats.length ? { candidats: f.candidats } : {}), ...(f.raison ? { raison: f.raison } : {}) })),
        note: faits.some((f) => f.statut === "A_VERIFIER") ? "Un fait À VÉRIFIER n'est rattaché à rien tant qu'une personne ne le rattache pas (attach_inbound_event) : le dire, proposer les candidats, ne jamais choisir à sa place." : null,
      });
    },
  },
  {
    def: {
      name: "attach_inbound_event",
      description:
        "RATTACHE un fait externe « à vérifier » (ou sans association) à une entité, en TYPE:id — l'un des candidats proposés par inbound_events, ou une autre entité que la personne nomme. "
        + "Complète le registre et réveille les missions qui attendaient cette entité. GESTE DE PERSONNE : uniquement sur sa demande explicite, jamais de ta propre initiative.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "L'identifiant du fait (inbound_events)." },
          ref: { type: "string", description: "L'entité, en TYPE:id (LEGAL_DOCUMENT:…, SUPPLIER:…, COMPANY:…, REGULATORY_PRODUCT:…)." },
        },
        required: ["id", "ref"],
      },
    },
    allowed: (u) => aVueGlobale(u),
    label: "Rattachement d'un fait externe",
    run: async (input, user) => JSON.stringify(await rattacherEvenement(user, { id: str(input, "id") || null, ref: str(input, "ref") })),
  },
];
