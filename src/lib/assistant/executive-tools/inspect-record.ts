import type { PowerTool } from "@/lib/assistant/power-tools";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { chainOf, amountDrift, type ChainDoc } from "@/lib/legal/chain";
import { paymentExecutiveState } from "@/lib/assistant/executive-state";
import { REGULATORY_STEP_TYPE as REG_STEP_FR } from "@/lib/labels";
import {
  REG_STEPS, hasWorkflowState, regProgress, workflowAsSteps, type RegWorkflowState,
} from "@/lib/assistant/regulatory-read";
import { geste, retardJours, retardLabel } from "@/lib/assistant/workspace/emit";
import { invoiceSettlementState, INVOICE_SETTLEMENT } from "@/lib/labels";
import { libelleEtape } from "@/platform/in-process/promo";
import { docKindFromName, EXEC, str, fr, validationsOf, auditOf, documentsOf, renderTimeline } from "./commun";

/**
 * OUTILS EXÉCUTIFS — l'HISTOIRE COMPLÈTE d'un dossier (`inspect_record`) : devis → BC → validateurs →
 * facture → règlement, avec les dates.
 *
 * Morceau de `EXECUTIVE_TOOLS` (`../executive-tools.ts`), recomposé dans l'ordre d'origine : l'ordre
 * des outils fait partie du prompt de l'IA.
 */
export const OUTILS_INSPECT_RECORD: PowerTool[] = [
  {
    def: {
      name: "inspect_record",
      description:
        "L'HISTOIRE COMPLÈTE d'un dossier à partir de sa RÉFÉRENCE, de son IDENTIFIANT interne (id rendu par une recherche) ou d'un fragment de titre : demande de paiement (PAY-…), " +
        "règlement/ordre de dépense, document Legal (devis, BC, facture, contrat), matériel promotionnel, demande du secrétariat " +
        "(REQ-…), sponsoring Ad&Pro (SPO-…), dossier Regulatory (REG-…), facture Finances, courrier du registre, projet délégué (DOS-…), tâche. " +
        "Renvoie la fiche, la TIMELINE reconstruite (qui a fait quoi, quand), les VALIDATEURS nommés avec leurs dates, les pièces " +
        "jointes, la chaîne devis→BC→facture→règlement quand elle existe, et les LIENS cliquables. " +
        "À utiliser pour « donne-moi toute l'histoire de cet achat », « qui a validé ? », « est-ce qu'on a payé ? », « où en est ce dossier ? ».",
      input_schema: {
        type: "object",
        properties: { reference: { type: "string", description: "Référence exacte (PAY-2026-014, ORD-…, REF du BC), identifiant interne rendu par une recherche (id), ou fragment de titre d'un document Legal." } },
        required: ["reference"],
      },
    },
    allowed: EXEC,
    label: "Dossier reconstitué",
    run: async (input, user) => {
      void user;
      // `query` est accepté comme SYNONYME de `reference` : le chemin rapide et la voix ont
      // longtemps servi ce nom-là, et un outil qui refuse une clé équivalente répond « il me
      // faut une référence » à quelqu'un qui vient d'en donner une.
      const brut = str(input, "reference") || str(input, "query");
      if (brut.length < 2) {
        // MÊME FORME QUE LES ONZE FICHES (§118.20) : une phrase nue tuerait toute référence
        // qu'un plan aurait écrite sur `type` ou `precision`.
        return JSON.stringify({
          type: null, reference: brut, trouve: false,
          precision: "Aucune référence ni fragment de titre n'a été donné : rien n'a été cherché.",
        });
      }

      /**
       * LE FRAGMENT SE RELIT SANS SON MOT-CLASSE. « dossier nivolumab », « contrat hetero »,
       * « le paiement hikma » : le premier mot dit le type, jamais l'identité — et aucun titre,
       * aucune DCI ne le contient. Quand la lecture littérale ne rend rien, on retente UNE fois
       * sans lui. Jamais l'inverse : le fragment complet garde la priorité, parce qu'un titre
       * peut réellement contenir « dossier ».
       */
      const nettoyer = (f: string): string =>
        f.replace(/^(?:(?:le|la|les|l'|l’|mon|ma|mes|ce|cet|cette|ces|du|de|des|d'|d’)\s+)*(?:dossier|produit|contrat|marché|marche|demande|projet|courrier|tâche|tache|paiement|facture|règlement|reglement|fiche)\s+(?:(?:de|du|des|d'|d’|pour|sur|concernant)\s+)?/i, "").trim();
      /**
       * ── LE RETRY NE SE DÉCIDE PLUS SUR UN PRÉFIXE DE CHAÎNE (§118.20) ─────────────────
       *
       * `inspecter` rendait une phrase commençant par « Aucun dossier ne porte » quand il ne
       * trouvait rien, et du JSON sinon — et le second essai se décidait en comparant ce
       * PRÉFIXE. Deux défauts dans la même ligne : la forme de la sortie dépendait de la donnée
       * (un plan ne pouvait rien écrire contre elle), et le contrôle de flux du fichier tenait à
       * une chaîne de caractères que n'importe quelle reformulation aurait cassée en silence.
       * `inspecter` DIT désormais s'il a trouvé, et rend toujours la même forme.
       */
      const premier = await inspecter(brut);
      if (premier.trouve) return premier.charge;
      const nettoye = nettoyer(brut);
      if (nettoye.length >= 2 && nettoye.toLowerCase() !== brut.toLowerCase()) {
        const second = await inspecter(nettoye);
        if (second.trouve) return second.charge;
      }
      return premier.charge;

      async function inspecter(ref: string): Promise<{ trouve: boolean; charge: string }> {
      /**
       * UNE SEULE FORME POUR ONZE TYPES DE FICHE. Chaque branche a ses champs propres — une
       * demande de paiement et un contrat n'ont pas les mêmes —, mais QUATRE clés existent
       * toujours : `type` (null quand rien n'est trouvé), `reference`, `trouve` et `precision`.
       * Un plan peut les référencer sans parier sur ce que la lecture rendra.
       */
      const fiche = (o: Record<string, unknown> & { precision?: string }): { trouve: boolean; charge: string } => {
        const trouve = o.type != null;
        return {
          trouve,
          charge: JSON.stringify({
            type: null, reference: ref, ...o, trouve,
            precision: o.precision ?? (trouve
              ? `Fiche « ${String(o.type)} » relue dans l'ERP — ce qui n'y figure pas n'a pas été tracé.`
              : "Aucune fiche ne correspond."),
          }),
        };
      };
      /**
       * L'IDENTIFIANT INTERNE EST RÉSOLU, PAS SEULEMENT LA RÉFÉRENCE — le correctif du Run 4.
       *
       * Le pipeline direct des missions (RECHERCHER → CIBLER → LIRE) recopie l'`id` EXACT rendu
       * par une recherche — c'est la consigne, et elle est juste. Or cet outil ne cherchait que
       * `reference`/`title` : servi avec l'id que le SYSTÈME LUI-MÊME avait rendu, il répondait
       * « Aucun dossier ne porte la référence » — contradiction relevée par le juge, replan
       * vide, mission BLOCKED (mesuré : COURRIERS, FINANCES, LEGAL, TACHES). Un identifiant
       * qu'on a distribué se relit ; chaque table porte donc `{ id: ref }` dans son OR — une
       * égalité stricte, qui ne peut rien attraper d'autre.
       */

      // 1) Demande de paiement.
      const pay = await prisma.paymentRequest.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        include: { pieces: { select: { kind: true, status: true, note: true } } },
      });
      if (pay) {
        const [timeline, validators, docs, order, valChrono] = await Promise.all([
          auditOf("PAYMENT_REQUEST", pay.id),
          validationsOf("PAYMENT_REQUEST", pay.id),
          documentsOf("PAYMENT_REQUEST", pay.id),
          pay.expenseOrderId
            ? prisma.expenseOrder.findUnique({
                where: { id: pay.expenseOrderId },
                select: { reference: true, status: true, centralStatus: true, paidDate: true, amount: true, createdAt: true },
              })
            : Promise.resolve(null),
          // La CHRONOLOGIE des marches de validation — la matière de l'état exécutif dérivé
          // (qui bloque, depuis combien de jours). Requête bornée, lancée en parallèle.
          prisma.validationRequest.findMany({
            where: { entityType: "PAYMENT_REQUEST", entityId: pay.id },
            select: { createdAt: true, steps: { select: { status: true, decidedAt: true, order: true, validator: { select: { name: true } } } } },
          }),
        ]);
        return fiche({
          type: "Demande de paiement",
          // L'ÉTAT EXÉCUTIF D'ABORD — « où est le paiement ? » = qui le bloque, depuis quand,
          // la prochaine étape, les signaux. Dérivé de la chronologie tracée (executive-state.ts).
          etatExecutif: paymentExecutiveState({
            status: pay.status, dueDate: pay.dueDate, createdAt: pay.createdAt,
            validations: valChrono.map((v) => ({
              createdAt: v.createdAt,
              steps: v.steps.map((s) => ({ status: s.status, decidedAt: s.decidedAt, order: s.order, validatorName: s.validator.name })),
            })),
            order: order ? { status: order.status, centralStatus: order.centralStatus, paidDate: order.paidDate, createdAt: order.createdAt } : null,
          }),
          reference: pay.reference, objet: pay.title, beneficiaire: pay.payee,
          montantDzd: Math.round(toNumber(pay.amount)), statut: pay.status,
          echeance: pay.dueDate ? fr(pay.dueDate) : null,
          pieces: pay.pieces.map((p) => ({ nature: p.kind, etat: p.status, note: p.note })),
          validateurs: validators,
          reglement: order
            ? {
                reference: order.reference, statut: order.status, centreDePaiement: order.centralStatus,
                payeLe: order.paidDate ? fr(order.paidDate) : null, montantDzd: Math.round(toNumber(order.amount)),
                lien: "/centre-de-paiement",
              }
            : "Aucun règlement créé — le bon à payer n'a pas encore été donné.",
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/validations/paiements/${pay.id}`,
        });
      }

      // 2) Ordre de dépense (règlement).
      const order = await prisma.expenseOrder.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { label: { contains: ref, mode: "insensitive" } }] },
        include: { requestedBy: { select: { name: true } } },
      });
      if (order) {
        const timeline = await auditOf("EXPENSE_ORDER", order.id);
        return fiche({
          type: "Règlement (ordre de dépense)",
          etatExecutif: paymentExecutiveState({
            status: order.status, dueDate: null, createdAt: order.createdAt, validations: [],
            order: { status: order.status, centralStatus: order.centralStatus, paidDate: order.paidDate, createdAt: order.createdAt },
          }),
          reference: order.reference, objet: order.label,
          montantDzd: Math.round(toNumber(order.amount)),
          statut: order.status, centreDePaiement: order.centralStatus,
          demandePar: order.requestedBy?.name ?? null,
          payeLe: order.paidDate ? fr(order.paidDate) : "pas encore payé",
          timeline: renderTimeline(timeline),
          liens: ["/finances/paiements-a-faire", "/centre-de-paiement"],
        });
      }

      // 3) Document Legal — et sa CHAÎNE devis → BC → facture → règlement.
      const legal = await prisma.legalDocument.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: { id: true, title: true, reference: true, kind: true, counterparty: true, amount: true, startDate: true, endDate: true, status: true, chainFromId: true, expenseOrderId: true, notes: true, signedAt: true, effectiveAt: true, driveNodeId: true },
      });
      if (legal) {
        // La chaîne se remonte par requêtes bornées — le fil est court, une boucle serait un gel.
        const byId = new Map<string, { id: string; kind: string; title: string; reference: string | null; chainFromId: string | null; amount: unknown; startDate: Date | null }>();
        const select = { id: true, kind: true, title: true, reference: true, chainFromId: true, amount: true, startDate: true } as const;
        byId.set(legal.id, { ...legal });
        for (let hop = 0; hop < 8; hop += 1) {
          const wanted = [...byId.values()].map((r) => r.chainFromId).filter((x): x is string => Boolean(x) && !byId.has(x!));
          const children = await prisma.legalDocument.findMany({ where: { OR: [{ id: { in: wanted.length ? wanted : ["-"] } }, { chainFromId: { in: [...byId.keys()] } }], id: { notIn: [...byId.keys()] } }, select });
          if (children.length === 0) break;
          for (const c of children) byId.set(c.id, c);
        }
        const docsChain: ChainDoc[] = [...byId.values()].map((r) => ({ id: r.id, kind: r.kind, chainFromId: r.chainFromId }));
        const fil = chainOf(docsChain, legal.id).map((d) => {
          const row = byId.get(d.id)!;
          return { nature: row.kind, reference: row.reference, titre: row.title, montantDzd: row.amount != null ? Math.round(toNumber(row.amount as never)) : null, lien: `/legal/${row.id}` };
        });
        // MOTEUR DE CONTRADICTION (déterministe) : devis et facture de la MÊME chaîne qui ne
        // disent pas le même montant — on ne choisit jamais l'un en silence, on SIGNALE l'écart
        // avec les deux valeurs ; au modèle de vérifier la chronologie (un avenant l'explique-t-il ?).
        const quoteAmt = fil.find((m) => m.nature === "QUOTE")?.montantDzd ?? null;
        const invoiceAmt = fil.find((m) => m.nature === "INVOICE")?.montantDzd ?? null;
        const drift = amountDrift(quoteAmt, invoiceAmt);
        const incoherences = drift != null && drift !== 0
          ? [`écart devis → facture : ${drift > 0 ? "+" : ""}${drift.toLocaleString("fr-FR")} DZD (devis ${quoteAmt?.toLocaleString("fr-FR")} / facture ${invoiceAmt?.toLocaleString("fr-FR")}) — vérifier la chronologie (avenant ?) avant de citer un montant`]
          : [];
        const [timeline, validators, docs, settlement] = await Promise.all([
          auditOf("LEGAL_DOCUMENT", legal.id),
          validationsOf("LEGAL_DOCUMENT", legal.id),
          documentsOf("LEGAL_DOCUMENT", legal.id),
          legal.expenseOrderId
            ? prisma.expenseOrder.findUnique({ where: { id: legal.expenseOrderId }, select: { reference: true, status: true, centralStatus: true, paidDate: true } })
            : Promise.resolve(null),
        ]);
        return fiche({
          type: "Document Legal", nature: legal.kind,
          reference: legal.reference, titre: legal.title, partie: legal.counterparty,
          montantDzd: legal.amount != null ? Math.round(toNumber(legal.amount)) : null,
          statut: legal.status,
          // LES NOTES DE LA FICHE FONT PARTIE DE LA FICHE : préavis, exclusivité, redevance y
          // sont souvent consignés — les taire, c'est répondre « aucune clause exploitable »
          // à côté de la clause. Le fichier signé, lui, se LIT (read_document) : on donne la porte.
          notes: legal.notes ?? null,
          signeLe: legal.signedAt ? fr(legal.signedAt) : null,
          effetLe: legal.effectiveAt ? fr(legal.effectiveAt) : null,
          documentSigne: legal.driveNodeId ? { driveNodeId: legal.driveNodeId, lien: `/drive/${legal.driveNodeId}`, lire: "read_document(driveNodeId)" } : null,
          ...(incoherences.length > 0 ? { incoherences } : {}),
          chaineAchat: fil.length > 1 ? fil : "Pièce isolée — aucun lien devis/BC/facture déclaré.",
          reglement: settlement
            ? { reference: settlement.reference, statut: settlement.status, centreDePaiement: settlement.centralStatus, payeLe: settlement.paidDate ? fr(settlement.paidDate) : null }
            : null,
          validateurs: validators,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/legal/${legal.id}`,
        });
      }

      // 4) Matériel promotionnel.
      const promo = await prisma.promoMaterial.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: { id: true, reference: true, title: true, circuitState: true, circuitVersion: true, tracksDone: true, status: true, chosenAgency: true, amount: true, chosenAmount: true },
      });
      if (promo) {
        const [timeline, docs] = await Promise.all([auditOf("PROMO_MATERIAL", promo.id), documentsOf("PROMO_MATERIAL", promo.id)]);
        return fiche({
          type: "Matériel promotionnel",
          reference: promo.reference, titre: promo.title,
          // L'étape EN CLAIR, dans le vocabulaire de son circuit — un code d'état brut
          // (« REVIEW_REQUESTER ») se recopie tel quel dans une réponse que personne ne lit.
          circuit: promo.circuitState ? libelleEtape(promo.circuitState as Parameters<typeof libelleEtape>[0], promo.circuitVersion === 2 ? 2 : 1) : promo.status,
          chantiersClos: promo.tracksDone ?? "",
          agence: promo.chosenAgency,
          montantDzd: Math.round(toNumber(promo.chosenAmount ?? promo.amount ?? 0)) || null,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/promo-material/${promo.id}`,
        });
      }

      // 5) Demande du secrétariat.
      const req = await prisma.administrativeRequest.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: { id: true, reference: true, title: true, type: true, status: true, assignedTo: { select: { name: true } } },
      });
      if (req) {
        const [timeline, docs] = await Promise.all([auditOf("ADMIN_REQUEST", req.id), documentsOf("ADMIN_REQUEST", req.id)]);
        return fiche({
          type: "Demande du secrétariat",
          reference: req.reference, titre: req.title, nature: req.type, statut: req.status,
          responsable: req.assignedTo?.name ?? null,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/demandes/${req.id}`,
        });
      }

      // 5 bis) Sponsoring Ad&Pro (SPO-…) — le trou mesuré en conversation réelle : Adam a déclaré
      // « SPO-2026-004 n'existe pas » sur un sponsoring parfaitement réel (ASARI), parce que cet
      // outil « universel » ne couvrait pas la table. Une vérification qui ne sait pas lire une
      // famille ne doit jamais conclure à l'inexistence — désormais elle la lit.
      const spo = await prisma.sponsoringRequest.findFirst({
        where: {
          OR: [
            { id: ref },
            { reference: { equals: ref, mode: "insensitive" } },
            { institution: { contains: ref, mode: "insensitive" } },
            { doctor: { contains: ref, mode: "insensitive" } },
          ],
        },
        select: {
          id: true, reference: true, institution: true, doctor: true, specialty: true, city: true,
          type: true, status: true, strategicImportance: true, product: true,
          amountRequested: true, amountProposed: true, amountGranted: true,
          requestDate: true, requester: { select: { name: true } },
          preliminaryAt: true, productManagerId: true, finalAt: true, finalDecision: true,
          expenseOrderId: true,
          company: { select: { shortName: true, name: true } },
        },
      });
      if (spo) {
        const [timeline, validators, docs, reglement] = await Promise.all([
          auditOf("SPONSORING", spo.id),
          validationsOf("SPONSORING", spo.id),
          documentsOf("SPONSORING", spo.id),
          spo.expenseOrderId
            ? prisma.expenseOrder.findUnique({
                where: { id: spo.expenseOrderId },
                select: { reference: true, status: true, centralStatus: true, paidDate: true, amount: true },
              })
            : Promise.resolve(null),
        ]);
        return fiche({
          type: "Sponsoring (Ad&Pro)",
          reference: spo.reference,
          institution: spo.institution, medecin: spo.doctor, specialite: spo.specialty, ville: spo.city,
          nature: spo.type, produit: spo.product,
          statut: spo.status, importanceStrategique: spo.strategicImportance,
          entite: spo.company?.shortName ?? spo.company?.name ?? null,
          demandePar: spo.requester?.name ?? null, demandeLe: fr(spo.requestDate),
          montants: {
            demandeDzd: spo.amountRequested != null ? Math.round(toNumber(spo.amountRequested)) : null,
            proposeDzd: spo.amountProposed != null ? Math.round(toNumber(spo.amountProposed)) : null,
            accordeDzd: spo.amountGranted != null ? Math.round(toNumber(spo.amountGranted)) : null,
          },
          circuit: {
            preValidationDirection: spo.preliminaryAt ? fr(spo.preliminaryAt) : "pas encore",
            analyseChefDeProduit: spo.productManagerId ? "faite ou en cours" : "pas encore",
            decisionFinale: spo.finalAt ? `${fr(spo.finalAt)}${spo.finalDecision ? ` — ${spo.finalDecision.slice(0, 160)}` : ""}` : "pas encore",
          },
          reglement: reglement
            ? {
                reference: reglement.reference, statut: reglement.status, centreDePaiement: reglement.centralStatus,
                montantDzd: Math.round(toNumber(reglement.amount)),
                payeLe: reglement.paidDate ? fr(reglement.paidDate) : "pas encore payé",
              }
            : null,
          validateurs: validators,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/sponsoring/${spo.id}`,
        });
      }

      // 6) Dossier Regulatory (REG-…, ou DCI / nom commercial).
      const reg = await prisma.regulatoryProduct.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { dci: { contains: ref, mode: "insensitive" } }, { brandName: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, reference: true, dci: true, brandName: true, status: true, priority: true,
          therapeuticClass: true, partnerLab: true, targetSubmissionDate: true, targetDate: true,
          workflow: true,
          company: { select: { shortName: true, name: true } },
          responsible: { select: { name: true } },
          steps: { select: { id: true, type: true, status: true, plannedDate: true, actualDate: true }, orderBy: { order: "asc" }, take: 30 },
        },
      });
      if (reg) {
        const [timeline, docs] = await Promise.all([auditOf("REGULATORY_PRODUCT", reg.id), documentsOf("REGULATORY_PRODUCT", reg.id)]);
        const lastMove = timeline.length ? timeline[timeline.length - 1] : null;
        /**
         * LA CARTE DU DOSSIER — l'objet montré en entier, dans l'ordre de la question.
         *
         * Le PDG qui ouvre un dossier en retard ne cherche pas une fiche : il cherche POURQUOI
         * ça n'avance pas. La frise du circuit et le blocage passent donc devant tout le reste,
         * et les quatre gestes du bas sont ceux qu'on pose vraiment sur un dossier bloqué.
         *
         * ── LA FRISE LIT LA MÊME SOURCE QUE L'ÉCRAN ──────────────────────────────────────
         *
         * Le défaut mesuré en conversation réelle : la fiche annonçait « Pré-soumission, étapes
         * non démarrées » alors que le journal disait « Dépôt du dossier → fait le 15/07 ». Les
         * deux disaient vrai — sur DEUX MAGASINS : l'équipe coche `RegulatoryProduct.workflow`
         * (les 22 étapes ANPP de l'écran), et cette fiche lisait la table `RegulatoryStep`, le
         * second registre que `workflowAsSteps` a déjà déclaré mort (regulatory-workflow.ts).
         * Quand le circuit est tenu, la frise le lit ; la table ne sert plus que de repli pour
         * un dossier jamais coché.
         */
        const circuitTenu = hasWorkflowState(reg.workflow as RegWorkflowState | null);
        const etapesCircuit = circuitTenu
          ? workflowAsSteps(reg.workflow as RegWorkflowState | null).map((s, i) => ({
              id: s.type,
              type: s.type,
              label: REG_STEPS[i]?.label ?? s.type,
              status: s.status,
              actualDate: s.actualDate,
            }))
          : reg.steps.map((s) => ({
              id: s.id,
              type: s.type,
              label: REG_STEP_FR[s.type] ?? String(s.type),
              status: s.status,
              actualDate: s.actualDate,
            }));
        const avancement = circuitTenu
          ? (() => { const p = regProgress(reg.workflow as RegWorkflowState | null); return `${p.done}/${p.total}`; })()
          : null;
        const cible = reg.targetDate ?? reg.targetSubmissionDate;
        const clos = reg.status === "DECISION_OBTAINED" || reg.status === "CLOSED";
        const retard = clos ? null : retardJours(cible);
        // L'ÉTAPE COURANTE : celle en cours, sinon la première qui bloque ou n'a pas démarré.
        const etapeCourante = etapesCircuit.find((st) => st.status === "IN_PROGRESS")
          ?? etapesCircuit.find((st) => st.status === "BLOCKED" || st.status === "LATE")
          ?? etapesCircuit.find((st) => st.status === "NOT_STARTED");

        const bloc = {
          kind: "dossier",
          title: reg.reference,
          subtitle: reg.brandName ? `${reg.dci} (${reg.brandName})` : reg.dci,
          ...(retard
            ? { badge: { label: "En retard", ton: "alerte" } }
            : clos
              ? { badge: { label: "Clôturé", ton: "succes" } }
              : {}),
          fields: [
            ...(reg.responsible?.name ? [{ label: "Chargé du dossier", value: reg.responsible.name }] : []),
            ...(etapeCourante ? [{ label: "Étape courante", value: etapeCourante.label }] : []),
            ...(avancement ? [{ label: "Avancement", value: `${avancement} étapes ANPP` }] : []),
            ...(retard ? [{ label: "Retard", value: retardLabel(retard) }] : []),
            ...(cible ? [{ label: "Échéance", value: fr(cible) }] : []),
            ...(reg.partnerLab ? [{ label: "Laboratoire", value: reg.partnerLab }] : []),
            ...(reg.company?.shortName || reg.company?.name ? [{ label: "Entité", value: (reg.company.shortName ?? reg.company.name) as string }] : []),
          ],
          ...(etapesCircuit.length
            ? {
                steps: (() => {
                  // La fenêtre glisse AUTOUR de l'étape courante : montrer les étapes 1 à 7 d'un
                  // dossier rendu à la 12ᵉ ferait croire que rien n'a bougé.
                  const idx = etapeCourante ? etapesCircuit.findIndex((st) => st.id === etapeCourante.id) : etapesCircuit.length;
                  const debut = Math.max(0, Math.min(idx - 2, etapesCircuit.length - 7));
                  return etapesCircuit.slice(debut, debut + 7).map((st) => ({
                    label: st.label,
                    etat: st.status === "DONE" ? "fait" : etapeCourante && st.id === etapeCourante.id ? "courant" : "a-venir",
                  }));
                })(),
              }
            : {}),
          ...(retard
            ? { alerte: { label: `Échéance dépassée de ${retardLabel(retard)}${etapeCourante ? ` — bloqué à l'étape « ${etapeCourante.label} »` : ""}.`, ton: "alerte" } }
            : {}),
          ...(docs.length
            ? {
                docs: docs.slice(0, 6).map((d) => ({
                  nom: d.nom, href: `/api/documents/${d.documentId}`,
                  type: docKindFromName(d.nom),
                  ...(d.categorie ? { soustitre: d.categorie } : {}),
                })),
              }
            : {}),
          ...(reg.responsible?.name ? { participants: [{ nom: reg.responsible.name, poste: "Chargé du dossier" }] } : {}),
          ...(timeline.length
            ? { activite: renderTimeline(timeline).slice(-3).reverse().map((t) => ({ date: t.date, label: t.par ? `${t.par} — ${t.evenement}` : t.evenement })) }
            : {}),
          lien: `/regulatory/${reg.id}`,
          actions: [
            geste("Relancer", `Prépare un mail de relance pour ${reg.reference}`, "primaire"),
            geste("Assigner", `Réassigne ${reg.reference}`),
            geste("Faire avancer", `Avance l'étape de ${reg.reference}`),
          ],
        };

        return fiche({
          type: "Dossier Regulatory",
          reference: reg.reference, dci: reg.dci, nomCommercial: reg.brandName,
          statut: reg.status, priorite: reg.priority,
          classeTherapeutique: reg.therapeuticClass, laboratoire: reg.partnerLab,
          entite: reg.company?.shortName ?? reg.company?.name ?? null,
          chargeDuDossier: reg.responsible?.name ?? null,
          ...(retard ? { retardJours: retard } : {}),
          datesCibles: {
            soumission: reg.targetSubmissionDate ? fr(reg.targetSubmissionDate) : null,
            objectif: reg.targetDate ? fr(reg.targetDate) : null,
          },
          // LES ÉTAPES = LE CIRCUIT COCHÉ PAR L'ÉQUIPE (même source que l'écran). L'ancienne
          // table `RegulatoryStep` ne sert plus que de repli pour un dossier jamais coché.
          ...(avancement ? { avancementCircuit: `${avancement} étapes ANPP faites` } : {}),
          etapes: etapesCircuit.map((s) => ({
            etape: s.label, etat: s.status,
            fait: s.actualDate ? fr(s.actualDate) : null,
          })),
          derniereActivite: lastMove ? { le: fr(lastMove.at), quoi: lastMove.label, par: lastMove.who } : "aucune trace au journal",
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/regulatory/${reg.id}`,
          _blocs: [bloc],
        });
      }

      // 7) Facture — un document légal de nature « facture », par n° ou objet.
      const invoice = await prisma.legalDocument.findFirst({
        where: {
          kind: "INVOICE",
          OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }],
        },
        select: {
          id: true, kind: true, reference: true, title: true, status: true, direction: true, amount: true,
          startDate: true, endDate: true, paidDate: true, counterparty: true, expenseOrderId: true,
          settlementTx: { select: { reference: true, date: true, amount: true } },
        },
      });
      if (invoice) {
        const etat = invoiceSettlementState(invoice);
        return fiche({
          type: "Facture (document légal)",
          numero: invoice.reference, objet: invoice.title,
          sens: invoice.direction === "IN" ? "émise (on encaisse)" : "reçue (on paie)",
          montantDzd: invoice.amount != null ? Math.round(toNumber(invoice.amount)) : null,
          statut: invoice.status,
          reglementEtat: INVOICE_SETTLEMENT[etat]?.label ?? null,
          emiseLe: invoice.startDate ? fr(invoice.startDate) : null,
          echeance: invoice.endDate ? fr(invoice.endDate) : null,
          payeeLe: invoice.paidDate ? fr(invoice.paidDate) : (etat === "IN_CIRCUIT" ? "partie au règlement" : "pas encore réglée"),
          partie: invoice.counterparty,
          reglement: invoice.settlementTx
            ? { ecriture: invoice.settlementTx.reference, le: fr(invoice.settlementTx.date), montantDzd: Math.round(toNumber(invoice.settlementTx.amount)) }
            : null,
          lien: `/legal/${invoice.id}`,
        });
      }

      // 8) Courrier du registre — par référence de chrono ou objet.
      const mail = await prisma.mailEntry.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, reference: true, title: true, direction: true, sender: true, recipient: true,
          sentAt: true, receivedAt: true, acknowledgedAt: true, carrier: true, notes: true, driveNodeId: true,
          concernedUser: { select: { name: true } }, department: { select: { name: true } },
          partner: { select: { name: true } },
          pieces: { select: { label: true, documentId: true, driveNodeId: true, recipient: true } },
        },
      });
      if (mail) {
        return fiche({
          type: "Courrier (registre)",
          reference: mail.reference, objet: mail.title,
          sens: mail.direction === "OUTGOING" ? "Départ" : "Arrivée",
          expediteur: mail.sender, destinataire: mail.recipient,
          partenaire: mail.partner?.name ?? null,
          parti: mail.sentAt ? fr(mail.sentAt) : null,
          arrive: mail.receivedAt ? fr(mail.receivedAt) : null,
          accuseDeReception: mail.acknowledgedAt ? fr(mail.acknowledgedAt) : "pas d'accusé enregistré",
          porteur: mail.carrier,
          concerne: [mail.concernedUser?.name, mail.department?.name].filter(Boolean).join(" · ") || null,
          pieces: [
            ...mail.pieces.map((p) => ({
              piece: p.label, destinataire: p.recipient,
              documentId: p.documentId, driveNodeId: p.driveNodeId,
            })),
            ...(mail.driveNodeId ? [{ piece: "Pli principal (Drive)", destinataire: null, documentId: null, driveNodeId: mail.driveNodeId }] : []),
          ],
          notes: mail.notes,
          lien: "/courriers",
        });
      }

      // 9) Projet délégué (DOS-…).
      const dossier = await prisma.dossier.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, reference: true, title: true, status: true, priority: true, category: true, dueDate: true,
          assignedTo: { select: { name: true } }, createdBy: { select: { name: true } },
          messages: { select: { body: true, createdAt: true, author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 },
        },
      });
      if (dossier) {
        const [timeline, docs] = await Promise.all([auditOf("DOSSIER", dossier.id), documentsOf("DOSSIER", dossier.id)]);
        return fiche({
          type: "Projet délégué",
          reference: dossier.reference, sujet: dossier.title, categorie: dossier.category,
          statut: dossier.status, priorite: dossier.priority,
          responsable: dossier.assignedTo?.name ?? "à assigner",
          ouvertPar: dossier.createdBy?.name ?? null,
          echeance: dossier.dueDate ? fr(dossier.dueDate) : null,
          derniersEchanges: dossier.messages.map((m) => ({ par: m.author?.name, le: fr(m.createdAt), extrait: m.body.slice(0, 160) })),
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/dossiers/${dossier.id}`,
        });
      }

      // 10) Tâche — par fragment de titre (en dernier : les titres sont les moins spécifiques).
      const task = await prisma.task.findFirst({
        where: { OR: [{ id: ref }, { title: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, title: true, description: true, status: true, priority: true, dueDate: true, createdAt: true,
          assignedTo: { select: { name: true } }, createdBy: { select: { name: true } },
          comments: { select: { body: true, createdAt: true, author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 },
        },
        orderBy: { createdAt: "desc" },
      });
      if (task) {
        return fiche({
          type: "Tâche",
          titre: task.title, detail: task.description,
          statut: task.status, priorite: task.priority,
          assigneeA: task.assignedTo?.name ?? null, creeePar: task.createdBy?.name ?? null,
          creeeLe: fr(task.createdAt),
          echeance: task.dueDate ? fr(task.dueDate) : null,
          enRetard: task.dueDate ? task.dueDate.getTime() < Date.now() && !["DONE", "CANCELLED"].includes(task.status) : false,
          derniersCommentaires: task.comments.map((c) => ({ par: c.author?.name, le: fr(c.createdAt), extrait: c.body.slice(0, 160) })),
          lien: "/mon-espace",
        });
      }

      return fiche({
        precision: `Aucun dossier ne porte la référence « ${ref} » (essayée comme référence, comme identifiant interne `
          + "et comme fragment de titre) — ni demande de paiement, ni règlement, ni document Legal, ni matériel "
          + "promotionnel, ni demande du secrétariat, ni sponsoring, ni dossier Regulatory, ni facture, ni courrier, "
          + "ni projet, ni tâche. Je préfère le dire plutôt que d'inventer.",
      });
      }
    },
  },
];
