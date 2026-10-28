/**
 * OPS VAGUE 5a — CONSULTING : contrat deux parties, validation désignée, tâches attendues. Par
 * les actions canoniques.
 */
import { prisma } from "./erp";
import { resoudreCible, direRefus, LIBELLE_POLE, poleDe, poleOppose, type PoleConsulting } from "@/platform/in-process/capacites";
import { createConsultingContract, requestConsultingValidation, decideConsultingContract, closeConsultingContract, addConsultingTask, toggleConsultingTask, deleteConsultingTask, transfererConsulting } from "@/lib/actions/consulting-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, isoDate, dzd, toFd } from "../../helpers";
import { fold } from "../../impl-regulatory";
import { resolvePerson, decisionOf } from "./commun";

// ─────────────────────────── CONSULTING ───────────────────────────

/** L'acteur, lu sur la SIGNATURE de `propose` — jamais un second chemin vers l'identité (§118.111). */
type Acteur = Parameters<OpImpl["propose"]>[1];

/**
 * LE CONTRAT DÉSIGNÉ — par le résolveur canonique (§118.85), donc SOUS LA PORTÉE du registre.
 *
 * La recherche se faisait en direct dans la table, sans acteur : n'importe qui atteignant l'op
 * recevait, dans la liste des candidats d'une désignation ambiguë, l'intitulé et le consultant
 * de contrats qu'il n'a pas le droit de lire. Depuis que le module qui garde un contrat dépend
 * de son PÔLE (§118.150), c'était la porte ouverte à côté de la fiche fermée : la promotion
 * retrouvait par une phrase le contrat qu'on venait de confier aux RH. Le registre borne les
 * lignes aux pôles que la personne lit, et compose le cloisonnement par entité (§118.71).
 */
async function resolveContract(raw: string, user: Acteur) {
  const texte = raw.trim();
  if (!texte) return { error: "Précisez le contrat de consulting (champ « reference » — CONS-…, intitulé ou consultant)." } as const;
  const r = await resoudreCible(user, "consulting_contract", texte);
  const refus = direRefus(r);
  if (refus) return { error: refus } as const;
  const c = await prisma.consultingContract.findUnique({
    where: { id: r.retenu[0].id },
    select: { id: true, reference: true, title: true, counterparty: true, status: true, pole: true },
  });
  return c ?? ({ error: `Aucun contrat de consulting « ${texte} » dans votre périmètre.` } as const);
}

/**
 * LE PÔLE QUE LA PHRASE NOMME — « aux RH », « en ressources humaines », « dans Ad & Pro ».
 * `null` quand elle n'en nomme aucun (le transfert va alors vers l'AUTRE pôle : il n'y en a que
 * deux) ; `"INCONNU"` quand elle nomme quelque chose qu'on ne lit pas à coup sûr — deviner une
 * destination serait pire que la redemander (§104.5).
 */
function poleNomme(raw: string): PoleConsulting | null | "INCONNU" {
  const t = fold(raw).replace(/[^a-z0-9]+/g, " ").trim();
  if (!t) return null;
  const rh = /\b(rh|ressources humaines|ressource humaine|hr)\b/.test(t);
  const adPro = /\b(ad pro|adpro|ad et pro|promotion)\b/.test(t);
  // Les DEUX nommés (« du consultant RH vers Ad & Pro ») : la phrase décrit un trajet, et en
  // retenir un serait choisir la destination à la place de la personne.
  if (rh === adPro) return "INCONNU";
  return rh ? "RH" : "AD_PRO";
}

async function resolveContractTask(contractId: string, contractLabel: string, raw: string) {
  const rows = await prisma.consultingTask.findMany({
    where: { contractId }, select: { id: true, label: true, doneAt: true }, orderBy: { position: "asc" }, take: 30,
  });
  if (rows.length === 0) return { error: `Le contrat ${contractLabel} n'a aucune tâche attendue.` } as const;
  const q = fold(raw);
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Précisez la tâche (champ « label ») parmi : ${rows.map((t) => t.label).join(" ; ")}.` } as const;
  }
  const hits = rows.filter((t) => fold(t.label).includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucune tâche « ${raw} » sur ${contractLabel} — tâches : ${rows.map((t) => t.label).join(" ; ")}.` } as const;
  return { error: `Plusieurs tâches correspondent : ${hits.map((t) => t.label).join(" ; ")} — préciser.` } as const;
}

export const CONSULTING_OPS_IMPL: Record<string, OpImpl> = {
  create_contract: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "name");
      if (!title) return { error: "Précisez l'intitulé du contrat (champ « label »)." };
      const counterparty = opStr(input, "counterparty") || opStr(input, "person");
      if (!counterparty) return { error: "Indiquez le consultant ou le cabinet (champ « counterparty ») — un contrat a deux parties." };
      const tasks = opStr(input, "tasks").split(/[;,\n]/).map((t) => t.trim()).filter(Boolean);
      return {
        title: `Contrat de consulting — ${title} (${counterparty})`,
        fields: fieldsOf([
          ["Intitulé", title], ["Consultant / cabinet", counterparty],
          ["Périmètre", opStr(input, "notes") || null],
          ["Début", isoDate(opStr(input, "startDate"))], ["Fin", isoDate(opStr(input, "endDate"))],
          ["Montant", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
          ["Tâches attendues", tasks.length ? tasks.join(" · ") : null],
        ]),
        warnings: ["Le contrat naît en BROUILLON (référence CONS- automatique) — il se soumet ensuite à validation."],
        args: {
          title, counterparty, scope: opStr(input, "notes") || null,
          startDate: isoDate(opStr(input, "startDate")), endDate: isoDate(opStr(input, "endDate")),
          amount: opStr(input, "amount") || null, paymentTerms: opStr(input, "paymentTerms") || null,
          tasks: tasks.join("\n") || null,
        },
        successMessage: `Contrat « ${title} » créé (brouillon).`,
        link: "/consulting", revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd2(createConsultingContract, args, "La création du contrat a été refusée.", { revalidate: ["/consulting"] }),
  },

  submit_contract: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in c) return c;
      let validatorId: string | null = null; let validatorName: string | null = null;
      if (opStr(input, "person")) {
        const v = await resolvePerson(opStr(input, "person"), "le validateur (champ « person »)");
        if ("error" in v) return v;
        validatorId = v.id; validatorName = v.name;
      }
      return {
        title: `Soumettre le contrat ${c.reference} à validation`,
        fields: fieldsOf([
          ["Contrat", `${c.reference} — ${c.title} (${c.counterparty})`],
          ["Validateur désigné", validatorName ?? "Direction (défaut)"],
        ]),
        warnings: ["La désignation ne crée pas le droit : le validateur doit déjà avoir VALIDATE sur Consulting."],
        args: { id: c.id, validatorId },
        successMessage: `Contrat ${c.reference} soumis${validatorName ? ` à ${validatorName}` : " à la Direction"}.`,
        revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd(requestConsultingValidation, args, "La soumission a été refusée.", { revalidate: ["/consulting"] }),
  },

  decide_contract: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in c) return c;
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision (champ « decision ») : valider ou refuser." };
      return {
        title: `${decision === "APPROVE" ? "VALIDER (activer)" : "REFUSER"} le contrat ${c.reference}`,
        fields: fieldsOf([["Contrat", `${c.reference} — ${c.title} (${c.counterparty})`], ["Note", opStr(input, "note") || null]]),
        warnings: decision === "APPROVE" ? ["Le contrat devient ACTIF."] : ["Le contrat est annulé, avec son motif."],
        args: { id: c.id, approve: decision === "APPROVE" ? "1" : "0", note: opStr(input, "note") || null },
        successMessage: `Contrat ${c.reference} ${decision === "APPROVE" ? "validé (actif)" : "refusé"}.`,
        revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd(decideConsultingContract, args, "La décision a été refusée.", { revalidate: ["/consulting"] }),
  },

  close_contract: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in c) return c;
      const cancel = /annul|romp|r[ée]sili/i.test(opStr(input, "decision")) || /annul|romp|r[ée]sili/i.test(opStr(input, "mode"));
      return {
        title: `${cancel ? "ROMPRE" : "Clore (expiration)"} le contrat ${c.reference}`,
        fields: fieldsOf([["Contrat", `${c.reference} — ${c.title} (${c.counterparty})`], ["Note", opStr(input, "note") || null]]),
        warnings: [cancel ? "Rupture en cours de contrat — tracée avec sa note." : "Clôture d'un contrat arrivé à son terme."],
        args: { id: c.id, cancel: cancel ? "1" : null, note: opStr(input, "note") || null },
        successMessage: `Contrat ${c.reference} ${cancel ? "rompu" : "clos"}.`,
        revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd(closeConsultingContract, args, "La clôture a été refusée.", { revalidate: ["/consulting"] }),
  },

  add_contract_task: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference"), user);
      if ("error" in c) return c;
      const label = opStr(input, "label") || opStr(input, "name");
      if (!label) return { error: "Décrivez la tâche attendue (champ « label »)." };
      return {
        title: `Ajouter la tâche « ${label} » au contrat ${c.reference}`,
        fields: fieldsOf([
          ["Contrat", `${c.reference} — ${c.title}`], ["Tâche", label],
          ["Échéance", isoDate(opStr(input, "dueDate"))],
        ]),
        args: { contractId: c.id, label, dueDate: isoDate(opStr(input, "dueDate")) },
        successMessage: `Tâche « ${label} » ajoutée au contrat ${c.reference}.`,
        revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd(addConsultingTask, args, "L'ajout de la tâche a été refusé.", { revalidate: ["/consulting"] }),
  },

  toggle_contract_task: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference"), user);
      if ("error" in c) return c;
      const task = await resolveContractTask(c.id, c.reference, opStr(input, "label") || opStr(input, "name"));
      if ("error" in task) return task;
      return {
        title: `${task.doneAt ? "Décocher" : "Marquer livrée"} — « ${task.label} » (${c.reference})`,
        fields: [{ label: "Tâche", value: `${task.label} — ${c.reference}` }, { label: "État", value: task.doneAt ? "Repassée à faire" : "Livrée" }],
        args: { taskId: task.id },
        successMessage: `Tâche « ${task.label} » ${task.doneAt ? "repassée à faire" : "marquée livrée"}.`,
        revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd(toggleConsultingTask, args, "L'opération a été refusée.", { revalidate: ["/consulting"] }),
  },

  delete_contract_task: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference"), user);
      if ("error" in c) return c;
      const task = await resolveContractTask(c.id, c.reference, opStr(input, "label") || opStr(input, "name"));
      if ("error" in task) return task;
      return {
        title: `Supprimer la tâche « ${task.label} » (${c.reference})`,
        fields: [{ label: "Tâche", value: `${task.label} — ${c.reference}` }],
        warnings: ["Un contrat clos ne se modifie plus (l'action refuse)."],
        args: { taskId: task.id },
        successMessage: `Tâche « ${task.label} » supprimée.`,
        revalidate: ["/consulting"],
      };
    },
    execute: (args) => runFd(deleteConsultingTask, args, "La suppression de la tâche a été refusée.", { revalidate: ["/consulting"] }),
  },

  /**
   * TRANSFÉRER UN CONTRAT D'UN PÔLE À L'AUTRE (§118.150) — Ad & Pro ⇄ Ressources humaines.
   *
   * La porte est dans le catalogue (`gate` : modifier les DEUX modules, la règle de l'action) :
   * la carte n'est jamais offerte à qui l'action refuserait (§118.83). La carte dit ce qui BOUGE
   * et ce qui ne bouge PAS avant le clic ; l'action rend ce qu'elle a réellement déplacé
   * (validation retirée, BC réaiguillés, désignation tombée), et c'est cette phrase qui revient.
   */
  transfer_contract: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveContract(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in c) return c;
      const depart = poleDe(c.pole);
      const nomme = poleNomme(opStr(input, "pole") || opStr(input, "decision") || opStr(input, "mode"));
      if (nomme === "INCONNU") {
        return { error: "Vers quel pôle ? Les deux pôles d'un contrat de consulting sont Ad & Pro et Ressources humaines (champ « pole » : AD_PRO ou RH)." };
      }
      const vers = nomme ?? poleOppose(depart);
      if (vers === depart) return { error: `Le contrat ${c.reference} relève déjà de ${LIBELLE_POLE[vers]}.` };
      return {
        title: `Transférer le contrat ${c.reference} de ${LIBELLE_POLE[depart]} vers ${LIBELLE_POLE[vers]}`,
        fields: fieldsOf([
          ["Contrat", `${c.reference} — ${c.title} (${c.counterparty})`],
          ["Pôle actuel", LIBELLE_POLE[depart]],
          ["Nouveau pôle", LIBELLE_POLE[vers]],
        ]),
        warnings: [
          `Le contrat quitte la liste de ${LIBELLE_POLE[depart]} : ceux qui n'ont que ce module ne le verront plus.`,
          "Rien n'est perdu : référence, tâches, pièces, validation et historique suivent le contrat — le geste inverse le ramène.",
          ...(depart === "AD_PRO" && c.status === "AWAITING_VALIDATION"
            ? ["S'il attend encore le centre Ad & Pro (au-dessus du seuil), sa validation y est retirée : un contrat RH ne passe pas par le centre de la promotion."]
            : []),
        ],
        args: { id: c.id, vers },
        successMessage: `Contrat ${c.reference} transféré vers ${LIBELLE_POLE[vers]}.`,
        link: `/consulting/${c.id}`, revalidate: ["/consulting", "/rh/consultants"],
      };
    },
    // L'action dit ce qu'elle a DÉPLACÉ — validation retirée, bons de commande réaiguillés,
    // désignation tombée. `runFd` jetterait ce message : on le rend tel quel.
    async execute(args) {
      const r = await transfererConsulting(toFd(args));
      if (!r.ok) return { ok: false, error: r.error ?? "Le transfert a été refusé." };
      return {
        ok: true, ...(r.id ? { createdId: r.id } : {}), ...(r.message ? { message: r.message } : {}),
        revalidate: ["/consulting", "/rh/consultants"],
      };
    },
  },
};
