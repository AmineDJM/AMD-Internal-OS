import { describe, it, expect } from "vitest";
import {
  isRequest, canRespond, canDoWork, canSee, canAttach, canComment, taskActions, requestStage, declineSummary,
  submitLabel, ACCEPTED_STATUS, taskCreationMode, creationNotices, commentsSummary, CREATION_STATUS,
} from "./request-flow";

const REQ = { requestedAt: new Date("2026-08-01"), createdById: "chef", assignedToId: "amine" };

describe("isRequest — distinguer une demande d'une tâche qu'on s'est donnée", () => {
  it("une tâche portant une date de demande en est une, quel que soit son statut", () => {
    expect(isRequest({ ...REQ, status: "IN_PROGRESS" })).toBe(true);
    expect(isRequest({ ...REQ, status: "DONE" })).toBe(true);
  });

  // Les demandes créées AVANT ce champ n'ont pas de `requestedAt` : leur statut suffit à les
  // reconnaître, sinon elles retomberaient dans le parcours des tâches ordinaires.
  it("le statut REQUESTED / DECLINED suffit, pour les demandes d'avant", () => {
    expect(isRequest({ status: "REQUESTED" })).toBe(true);
    expect(isRequest({ status: "DECLINED" })).toBe(true);
  });

  it("une tâche ordinaire n'en est pas une", () => {
    expect(isRequest({ status: "TODO", assignedToId: "amine", createdById: "amine" })).toBe(false);
  });
});

describe("canRespond — seul le destinataire accepte ou refuse", () => {
  const pending = { ...REQ, status: "REQUESTED" };

  it("le destinataire répond", () => {
    expect(canRespond(pending, "amine")).toBe(true);
  });

  // Accepter à la place de quelqu'un, c'est lui attribuer un engagement qu'il n'a pas pris.
  it("ni le demandeur, ni un tiers", () => {
    expect(canRespond(pending, "chef")).toBe(false);
    expect(canRespond(pending, "autre")).toBe(false);
  });

  it("on ne répond pas deux fois", () => {
    expect(canRespond({ ...REQ, status: "IN_PROGRESS" }, "amine")).toBe(false);
    expect(canRespond({ ...REQ, status: "DECLINED" }, "amine")).toBe(false);
  });
});

describe("canDoWork — qui fait et valide le travail", () => {
  it("le responsable et les participants", () => {
    const t = { ...REQ, status: "IN_PROGRESS", participantIds: ["nadia"] };
    expect(canDoWork(t, "amine")).toBe(true);
    expect(canDoWork(t, "nadia")).toBe(true);
  });

  // Valider le travail d'autrui reviendrait à signer à sa place.
  it("ni le demandeur, ni un simple lecteur", () => {
    const t = { ...REQ, status: "IN_PROGRESS", readerIds: ["direction"] };
    expect(canDoWork(t, "chef")).toBe(false);
    expect(canDoWork(t, "direction")).toBe(false);
  });

  it("rien à faire tant que la demande n'est pas acceptée, ni après un refus", () => {
    expect(canDoWork({ ...REQ, status: "REQUESTED" }, "amine")).toBe(false);
    expect(canDoWork({ ...REQ, status: "DECLINED" }, "amine")).toBe(false);
    expect(canDoWork({ ...REQ, status: "CANCELLED" }, "amine")).toBe(false);
  });

  it("le travail reste modifiable après validation", () => {
    expect(canDoWork({ ...REQ, status: "DONE" }, "amine")).toBe(true);
  });
});

describe("canSee / canAttach — le cercle de la demande", () => {
  const t = { ...REQ, status: "IN_PROGRESS", participantIds: ["nadia"], readerIds: ["direction"] };

  it("les quatre rôles du cercle voient", () => {
    for (const id of ["amine", "chef", "nadia", "direction"]) expect(canSee(t, id), id).toBe(true);
  });

  it("personne d'autre — une demande n'est pas publique parce qu'on a le module", () => {
    expect(canSee(t, "inconnu")).toBe(false);
  });

  it("la direction générale voit tout", () => {
    expect(canSee(t, "inconnu", true)).toBe(true);
  });

  it("le demandeur peut joindre une pièce : il complète SA demande", () => {
    expect(canAttach(t, "chef")).toBe(true);
    expect(canAttach(t, "direction")).toBe(false);
  });
});

describe("taskActions — ce qui est proposé, et surtout ce qui ne l'est plus", () => {
  // LE POINT DE LA DEMANDE : une fois acceptée, on entre et on travaille. Rien d'autre.
  it("une demande acceptée ne propose JAMAIS « Démarrer » ni « Projet »", () => {
    const accepted = { ...REQ, status: ACCEPTED_STATUS };
    const actions = taskActions(accepted, "amine", { canCreateDossier: true });
    expect(actions).not.toContain("start");
    expect(actions).not.toContain("dossier");
    expect(actions).not.toContain("complete");
    expect(actions).toEqual(["open"]);
  });

  it("une demande en attente propose d'accepter / refuser, au seul destinataire", () => {
    const pending = { ...REQ, status: "REQUESTED" };
    expect(taskActions(pending, "amine")).toContain("respond");
    expect(taskActions(pending, "chef")).not.toContain("respond");
    // Le demandeur peut quand même ouvrir : c'est sa demande. Et la RELANCER — c'est le seul
    // geste qu'il ait sur une demande en attente, et il lui manquait.
    expect(taskActions(pending, "chef")).toEqual(["relance", "open"]);
  });

  it("une demande refusée s'ouvre encore — c'est là qu'on lit le motif", () => {
    expect(taskActions({ ...REQ, status: "DECLINED" }, "chef")).toEqual(["open"]);
  });

  it("une tâche ORDINAIRE garde son parcours : démarrer, terminer, ouvrir un projet", () => {
    const todo = { status: "TODO", assignedToId: "amine", createdById: "amine" };
    expect(taskActions(todo, "amine", { canCreateDossier: true })).toEqual(["start", "complete", "dossier"]);
  });

  it("une tâche terminée ne propose plus de la terminer", () => {
    const done = { status: "DONE", assignedToId: "amine", createdById: "amine" };
    expect(taskActions(done, "amine")).toEqual([]);
  });

  it("en lecture seule, aucun bouton", () => {
    expect(taskActions({ ...REQ, status: "REQUESTED" }, "amine", { readOnly: true })).toEqual([]);
  });

  it("une tâche qui ne me concerne pas ne me propose rien", () => {
    expect(taskActions({ status: "TODO", assignedToId: "x", createdById: "y" }, "moi")).toEqual([]);
  });
});

describe("requestStage — où en est la demande, dit à l'oral", () => {
  it("couvre chaque étape", () => {
    expect(requestStage({ ...REQ, status: "REQUESTED" })).toBe("En attente de réponse");
    expect(requestStage({ ...REQ, status: "DECLINED" })).toBe("Refusée");
    expect(requestStage({ ...REQ, status: "IN_PROGRESS" })).toBe("Acceptée — en cours");
    expect(requestStage({ ...REQ, status: "DONE" })).toBe("Travail validé");
  });
});

describe("declineSummary — le motif est facultatif, et l'absence se dit", () => {
  it("reprend le motif quand il y en a un", () => {
    expect(declineSummary("Je suis en congé la semaine prochaine")).toContain("congé");
  });

  // Sans cette phrase, le demandeur voit un refus muet et rappelle pour demander pourquoi.
  it("dit explicitement qu'il n'y en a pas, plutôt que de laisser un vide", () => {
    expect(declineSummary(null)).toBe("Refusée, sans motif précisé.");
    expect(declineSummary("   ")).toBe("Refusée, sans motif précisé.");
  });
});

describe("submitLabel — on valide une fois, ensuite on met à jour", () => {
  it("change après la première validation", () => {
    expect(submitLabel({ ...REQ, status: "IN_PROGRESS" })).toBe("Valider mon travail");
    expect(submitLabel({ ...REQ, status: "DONE" })).toBe("Mettre à jour mon travail");
  });
});


describe("taskCreationMode — le destinataire décide de la nature du geste", () => {
  it("pour soi, c'est une to-do : personne n'accepte ce qu'il s'impose", () => {
    expect(taskCreationMode("amine", "amine")).toBe("self");
  });

  it("pour quelqu'un d'autre, c'est une demande", () => {
    expect(taskCreationMode("karim", "amine")).toBe("request");
  });

  it("sans destinataire choisi, on retombe sur soi — un formulaire à moitié rempli ne délègue pas", () => {
    expect(taskCreationMode(null, "amine")).toBe("self");
    expect(taskCreationMode(undefined, "amine")).toBe("self");
    expect(taskCreationMode("", "amine")).toBe("self");
    expect(taskCreationMode("   ", "amine")).toBe("self");
  });

  it("chaque mode a son statut de départ", () => {
    expect(CREATION_STATUS[taskCreationMode("amine", "amine")]).toBe("TODO");
    expect(CREATION_STATUS[taskCreationMode("karim", "amine")]).toBe("REQUESTED");
  });
});

describe("creationNotices — qui est prévenu, et qui est INTERROMPU", () => {
  it("le destinataire d'une demande reçoit une POP-UP : elle attend sa réponse", () => {
    const out = creationNotices({ creatorId: "amine", assignedToId: "karim", mode: "request" });
    expect(out).toEqual([{ userId: "karim", title: "Demande de tâche", popup: true }]);
  });

  it("participants et lecteurs reçoivent la cloche, jamais la pop-up", () => {
    const out = creationNotices({
      creatorId: "amine", assignedToId: "karim", mode: "request",
      participantIds: ["leila"], readerIds: ["samir"],
    });
    expect(out.filter((n) => n.popup).map((n) => n.userId)).toEqual(["karim"]);
    expect(out.map((n) => n.userId)).toEqual(["karim", "leila", "samir"]);
  });

  it("une tâche pour soi ne prévient personne", () => {
    expect(creationNotices({ creatorId: "amine", assignedToId: "amine", mode: "self" })).toEqual([]);
  });

  it("une tâche pour soi prévient tout de même ceux qu'on y associe", () => {
    const out = creationNotices({
      creatorId: "amine", assignedToId: "amine", mode: "self",
      participantIds: ["leila"], readerIds: ["samir"],
    });
    expect(out.map((n) => n.userId)).toEqual(["leila", "samir"]);
    expect(out.some((n) => n.popup)).toBe(false);
  });

  it("une seule notification par personne, même figurant deux fois", () => {
    const out = creationNotices({
      creatorId: "amine", assignedToId: "karim", mode: "request",
      participantIds: ["karim", "leila"], readerIds: ["leila"],
    });
    expect(out.map((n) => n.userId)).toEqual(["karim", "leila"]);
  });

  it("jamais au créateur — être prévenu de ce qu'on vient de faire use la cloche", () => {
    const out = creationNotices({
      creatorId: "amine", assignedToId: "karim", mode: "request",
      participantIds: ["amine"], readerIds: ["amine"],
    });
    expect(out.map((n) => n.userId)).toEqual(["karim"]);
  });

  it("ignore un identifiant vide plutôt que de créer une notification orpheline", () => {
    const out = creationNotices({
      creatorId: "amine", assignedToId: "karim", mode: "request", participantIds: [""],
    });
    expect(out.map((n) => n.userId)).toEqual(["karim"]);
  });
});

describe("canComment — qui voit peut écrire", () => {
  const task = {
    status: "IN_PROGRESS", requestedAt: new Date("2026-08-01"),
    createdById: "amine", assignedToId: "karim",
    participantIds: ["leila"], readerIds: ["samir"],
  };

  it("le demandeur et celui qui fait", () => {
    expect(canComment(task, "amine")).toBe(true);
    expect(canComment(task, "karim")).toBe(true);
  });

  it("un participant", () => {
    expect(canComment(task, "leila")).toBe(true);
  });

  it("un LECTEUR aussi — on l'a nommé parce qu'il connaît le sujet", () => {
    expect(canComment(task, "samir")).toBe(true);
  });

  it("personne d'autre", () => {
    expect(canComment(task, "inconnu")).toBe(false);
  });

  it("une tâche REFUSÉE reste commentable : c'est là qu'on explique et qu'on convient de la suite", () => {
    expect(canComment({ ...task, status: "DECLINED" }, "karim")).toBe(true);
    expect(canDoWork({ ...task, status: "DECLINED" }, "karim")).toBe(false);
  });
});

describe("commentsSummary", () => {
  it("annonce le vide plutôt que d'afficher un cadre nu", () => {
    expect(commentsSummary(0)).toBe("Aucun échange pour l'instant.");
  });

  it("accorde le pluriel", () => {
    expect(commentsSummary(1)).toBe("1 message");
    expect(commentsSummary(4)).toBe("4 messages");
  });
});
