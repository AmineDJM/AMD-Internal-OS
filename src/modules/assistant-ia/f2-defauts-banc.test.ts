import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT F2 — LES DÉFAUTS PRODUIT DU PASSAGE RÉEL DU 02/11 (soir), REJOUÉS CONTRE LA VRAIE BASE.
 * Rapport : docs/assistant/preuves/audit/ANALYSE.md. Chaque bloc nomme la tâche du banc qu'il tient.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { accesAssistantIa } from "./infra/role-config";
import { familleOuverte, famillesAJuger, gestePourSoi } from "./domaine/acces-regles";
import { censurerTexte } from "./domaine/filtre-confidentialite";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "./infra/generer";
import { modeleFactice } from "./infra/testing/modele-factice";
import { deleguerALaVoix } from "./infra/voix/temps-reel";
import { enregistrerSessionVoix } from "./infra/voix/oral";
import { lirePlan } from "@/lib/missions/travaux/plan";
import { PERSONA_ASSISTANT_IA } from "./infra/travaux";
import { outilsMails } from "./infra/mails/boites";
import { deposerMessage, ETAT, traiterFil } from "./infra/fil/service";
import { messageDEchec } from "./infra/fil/tour";
import { retirerCaduquesAvantLeTour } from "@/platform/ia/intentions/action-intents";
import { estQuestionOuRappel } from "@/platform/ia/intentions/proposition-perimee";
import { porteUneConsigne, separerDitEtConsigne, sortieOrale } from "@/platform/ia/voix/dit-et-consigne";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__f2_${Date.now().toString(36)}_`;

async function compte(nom: string, role: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: role as never } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

describe("F2 · TR-RH — les gestes pour soi (règle pure)", () => {
  it("sans champ d'autrui, les familles du dossier RH ne se jugent pas ; avec, si", () => {
    expect(gestePourSoi("hr-actions:requestLeave", { startDate: "2026-12-21" })).toBe(true);
    expect(gestePourSoi("hr-actions:requestLeave", { employeeId: "x" })).toBe(false);
    expect(gestePourSoi("hr-actions:decideLeave", {})).toBe(false);
    expect(famillesAJuger("hr-actions:requestAdvance", ["SALAIRES", "ECRITURES"], { amount: 30000 })).toEqual(["ECRITURES"]);
    expect(famillesAJuger("hr-actions:requestAdvance", ["SALAIRES", "ECRITURES"], { amount: 1, employeeId: "e" })).toEqual(["SALAIRES", "ECRITURES"]);
    // Un geste qui n'est pas « pour soi » garde toutes ses familles.
    expect(famillesAJuger("hr-actions:cancelAdvance", ["SALAIRES", "ECRITURES"])).toEqual(["SALAIRES", "ECRITURES"]);
  });

  it("TR-RH-06 : le montant d'une avance dit par la personne arrive au modèle ; une rémunération reste masquée", () => {
    expect(censurerTexte("Je voudrais demander une avance sur salaire de 30 000 DZD.").texte).toContain("30 000 DZD");
    expect(censurerTexte("un acompte sur mon salaire de 20 000 DA").texte).toContain("20 000 DA");
    expect(censurerTexte("Mon salaire net est de 180 000 DZD").texte).not.toContain("180 000");
    expect(censurerTexte("Le salaire de base: 90 000 DA").texte).not.toContain("90 000");
  });
});

suite("F2 · TR-RH-01/02/04/06 — son congé, son absence, son avance, son attestation (base réelle)", () => {
  let radia: CurrentUser;
  let ficheRadia: { id: string };
  let ficheAutre: { id: string };

  beforeAll(async () => {
    radia = await compte("Radia", "SALES_USER");
    ficheRadia = await prisma.employee.create({ data: { fullName: `Radia KEBIR ${TAG}`, userId: radia.id, isActive: true } });
    ficheAutre = await prisma.employee.create({ data: { fullName: `Assia ABDELAZIZ ${TAG}`, isActive: true } });
  });
  afterAll(async () => {
    const empl = { employee: { fullName: { contains: TAG } } };
    await prisma.leaveRequest.deleteMany({ where: empl }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: empl }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: empl }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: radia?.id } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const outil = async (nom: string, props: PropositionPreparee[]) => {
    const o = outilsV1(radia, props, [], [], null, await accesAssistantIa(radia), { capacites: true }).find((t) => t.def.name === nom);
    if (!o) throw new Error(`capacité ${nom} absente`);
    return o;
  };

  it("les familles RH restent FERMÉES pour elle (rien n'est rouvert sur autrui)", async () => {
    const acces = await accesAssistantIa(radia);
    expect(familleOuverte(acces, "FICHES")).toBe(false);
    expect(familleOuverte(acces, "SALAIRES")).toBe(false);
    expect(familleOuverte(acces, "CONTRATS_RH")).toBe(false);
  });

  it("TR-RH-01/02 : son congé annuel et son absence maladie — une carte ; confirmée, posée sur SA fiche", async () => {
    ACTEUR = radia;
    for (const type of ["ANNUAL", "SICK"]) {
      const props: PropositionPreparee[] = [];
      const sortie = JSON.parse(await (await outil("hr__requestLeave", props)).run({ startDate: "2026-12-21", endDate: "2026-12-31", type }, radia));
      expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
      const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    expect(await prisma.leaveRequest.count({ where: { employeeId: ficheRadia.id } })).toBe(2);
  });

  it("son propre nom recopié dans « employeeId » : retiré, le geste reste pour soi", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr__requestLeave", props)).run({ startDate: "2027-01-04", endDate: "2027-01-05", employeeId: `Radia KEBIR ${TAG}` }, radia));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(JSON.stringify(props[0]!.proposition.payload)).not.toContain("employeeId");
  });

  it("le congé d'AUTRUI reste refusé : la famille « Fiches collaborateurs » se juge sur autrui", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr__requestLeave", props)).run({ startDate: "2026-12-21", endDate: "2026-12-31", employeeId: `Assia ABDELAZIZ ${TAG}` }, radia));
    expect(sortie.statut).not.toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props).toHaveLength(0);
    expect(await prisma.leaveRequest.count({ where: { employeeId: ficheAutre.id } })).toBe(0);
  });

  it("TR-RH-06 : son avance de 30 000 DZD — une carte au bon montant ; confirmée, sur SA fiche", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr__requestAdvance", props)).run({ amount: 30000, reason: "Avance" }, radia));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const intent = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: props[0]!.intentId } });
    const r = await confirmerIntentionAssistantIA(intent.id, intent.confirmText ?? undefined);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const avance = await prisma.salaryAdvance.findFirstOrThrow({ where: { employeeId: ficheRadia.id } });
    expect(Number(avance.amount)).toBe(30000);
    // L'avance d'autrui : refusée.
    const autre: PropositionPreparee[] = [];
    expect(JSON.parse(await (await outil("hr__requestAdvance", autre)).run({ amount: 30000, employeeId: `Assia ABDELAZIZ ${TAG}` }, radia)).statut).not.toBe("EN_ATTENTE_DE_CONFIRMATION");
  });

  it("TR-RH-04 : son attestation de travail — l'action de l'ERP, sans mois de note de frais exigé ; confirmée, la demande RH est à SON nom", async () => {
    ACTEUR = radia;
    const props: PropositionPreparee[] = [];
    const sortie = JSON.parse(await (await outil("hr-document__requestHrDocument", props)).run({ type: "WORK_CERTIFICATE", details: "Pour la banque" }, radia));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await prisma.hrDocumentRequest.count({ where: { employeeId: ficheRadia.id, type: "WORK_CERTIFICATE" } })).toBe(1);
  });
});

describe("F2 · TR-VX-02 — ce qui est dit ne porte jamais une consigne (règle pure)", () => {
  it("la consigne d'attente du banc : rien n'en est dit", () => {
    const brut = "Le travail est lancé, il n'y a pas encore de résultat. Dis en quelques mots que tu regardes et que tu préviens dès que c'est prêt. N'invente aucun résultat et ne pose pas de question de toi-même.";
    expect(separerDitEtConsigne(brut).dit).toBe("");
    expect(separerDitEtConsigne(brut).consigne).toContain("N'invente aucun résultat");
    expect(porteUneConsigne("Dis-le simplement.")).toBe(true);
    expect(porteUneConsigne("Radia, il vous reste 30 jours de congé.")).toBe(false);
  });

  it("une réponse est dite telle quelle ; une parole citée reste dite ; la consigne passe au canal silencieux", () => {
    expect(separerDitEtConsigne("Le mail est prêt : il part à 10 h ; la Direction est en copie.")).toEqual({ dit: "Le mail est prêt : il part à 10 h ; la Direction est en copie.", consigne: "" });
    const r = sortieOrale({ pourVoix: "C'est fait : Tâche créée. Annonce-le simplement, en une phrase.", consigne: "Sois bref." });
    expect(r.pourVoix).toBe("C'est fait : Tâche créée.");
    expect(r.consigne).toBe("Sois bref. Annonce-le simplement, en une phrase.");
    expect(separerDitEtConsigne("Dis en quelques mots « Noté, en PDF » et que le travail en tient compte — sans résultat inventé.").dit).toBe("Noté, en PDF.");
    expect(separerDitEtConsigne("Récapitule la demande — Créer tâche : titre Relancer. Termine par « Tu confirmes ? ».").dit).toBe("Créer tâche : titre Relancer. Tu confirmes ?");
  });
});

suite("F2 · TR-VX-02 — « combien de jours de congé il me reste ? » à la voix (base réelle)", () => {
  let u: CurrentUser;
  const S = `live_${TAG}voix`;
  const cle = process.env.OPENAI_API_KEY;
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    remplacerModelesPourTests([modeleFactice([{ texte: JSON.stringify({ message: "Il vous reste 30 jours de congé.", components: [] }) }]).modele as never]);
    u = await compte("Voix", "SALES_USER");
    await enregistrerSessionVoix(u.id, S, null);
  });
  afterAll(async () => {
    if (cle === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cle;
    remplacerLecteurInterrupteurIaPourTests(null);
    remplacerModelesPourTests(null);
    await new Promise((ok) => setTimeout(ok, 300));
    await prisma.assistantIaVoixTravail.deleteMany({ where: { userId: u?.id } }).catch(() => {});
    await prisma.assistantIaVoixSession.deleteMany({ where: { userId: u?.id } }).catch(() => {});
    await prisma.assistantIaFil.deleteMany({ where: { userId: u?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Voix` } } }).catch(() => {});
  });

  it("le travail est lancé : la voix DIT « je regarde » ; la consigne d'attente est à part, jamais dans ce qui est dit", async () => {
    const r = await deleguerALaVoix(u, "Combien de jours de congé il me reste ?", { session: S, delegationId: "d1" });
    expect(r.travail).toBeTruthy();
    expect(r.pourVoix).toMatch(/je regarde/i);
    expect(r.pourVoix).not.toMatch(/Dis |N'invente|ne pose pas de question|de toi-même|pas encore de résultat/);
    expect(r.consigne).toContain("N'invente aucun résultat");
    // « stop » : rien n'est dit, la consigne seule part.
    const stop = await deleguerALaVoix(u, "stop", { session: S, delegationId: "d2", parole: "stop" });
    expect(stop).toMatchObject({ pourVoix: "", commande: "stop" });
    expect(stop.consigne).toContain("tais-toi");
  });
});

/** Le plan EXACT que le modèle a écrit au banc réel (MI-01, 02/11) : l'étape de lecture désignait « trouver_outil ». */
const PLAN_MI01 = {
  titre: "Analyse de mes demandes Ad & Pro — 2026", objectif: "Analyser toutes les demandes Ad & Pro de l'année et produire un rapport Word.", priorite: "NORMALE",
  etapes: [
    { cle: "rechercher-lecture", titre: "Identifier la lecture des demandes Ad & Pro", type: "LECTURE", outil: "trouver_outil", apres: [], entree: {} },
    { cle: "analyser-demandes", titre: "Lire et analyser les demandes de 2026", type: "ANALYSE", apres: ["rechercher-lecture"], consigne: "Analyser leur répartition, leurs statuts." },
    { cle: "rapport-word", titre: "Produire le rapport Word", type: "LIVRABLE", apres: ["analyser-demandes"], consigne: "Rédiger un rapport Word.", format: "docx" },
  ],
};

describe("F2 · MI-01/DOC-11 — le compilateur de plan résout les lectures du catalogue (pur)", () => {
  const catalogue = { lectures: [{ nom: "demandes_adpro", libelle: "Demandes Ad & Pro consultées" }, { nom: "directory_lookup", libelle: "Annuaire consulté" }], gestes: [] };
  it("sans résolveur : refusé, et la faute LISTE les lectures ouvertes (le modèle corrige au lieu de deviner)", () => {
    const r = lirePlan(PLAN_MI01, catalogue);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("lectures ouvertes : demandes_adpro, directory_lookup");
  });
  it("avec le résolveur de la persona : l'étape désigne la lecture du catalogue ; jamais un nom hors catalogue", () => {
    const r = lirePlan(PLAN_MI01, { ...catalogue, resoudreLecture: (i) => (/ad & pro/i.test(i) ? "demandes_adpro" : null) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.etapes[0]!.outil).toBe("demandes_adpro");
    const hors = lirePlan(PLAN_MI01, { ...catalogue, resoudreLecture: () => "requete_sql" });
    expect(hors.ok).toBe(false);
  });
});

suite("F2 · MI-01 — le plan du banc, relu par la persona réelle d'un KAM (base réelle)", () => {
  let kam: CurrentUser;
  beforeAll(async () => {
    kam = await compte("Kam", "BUSINESS_DEVELOPMENT_MANAGER");
    for (const module of ["SPONSORING", "EVENTS", "AD_PRO_OTHER", "VALIDATIONS"]) {
      await prisma.userAccess.create({ data: { userId: kam.id, module: module as never, canView: true, canCreate: true, scope: "ASSIGNED" } }).catch(() => {});
    }
  });
  afterAll(async () => {
    await prisma.userAccess.deleteMany({ where: { userId: kam?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Kam` } } }).catch(() => {});
  });

  it("« trouver_outil » est résolu en la lecture des demandes Ad & Pro ouverte à la personne ; le plan passe", async () => {
    const cat = await PERSONA_ASSISTANT_IA.catalogue(kam.id);
    expect(cat.lectures.map((l) => l.nom)).toContain("demandes_adpro");
    const r = lirePlan(PLAN_MI01, cat);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.plan.etapes[0]!.outil).toBe("demandes_adpro");
  });
});

describe("F2 · MG-10 — un tour sans réponse du modèle : message honnête (pur)", () => {
  it("le délai dépassé est dit comme tel ; une panne aussi — jamais « réessayez » seul", () => {
    expect(messageDEchec(new Error("délai dépassé (240000 ms)"))).toMatch(/dépassé le délai \(4 min\)/);
    expect(messageDEchec(new Error("fetch failed"))).toMatch(/le modèle n'a pas répondu/);
  });
});

suite("F2 · MG-10 — le fil REPREND une demande dont le modèle n'a pas répondu (base réelle)", () => {
  let u: CurrentUser;
  const cle = process.env.OPENAI_API_KEY;
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    u = await compte("Reprise", "SALES_USER");
  });
  afterAll(async () => {
    if (cle === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cle;
    remplacerLecteurInterrupteurIaPourTests(null);
    remplacerModelesPourTests(null);
    await prisma.assistantIaFil.deleteMany({ where: { userId: u?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Reprise` } } }).catch(() => {});
  });

  it("premier appel en panne → la cause est dite, la demande est rejouée, la réponse arrive", async () => {
    let appels = 0;
    remplacerModelesPourTests([modeleFactice([(prompt) => {
      appels++;
      if (appels === 1) throw new Error("fetch failed");
      return { texte: JSON.stringify({ message: prompt.includes("caisse") ? "Le rapprochement est prêt." : "Titre", components: [] }) };
    }]).modele as never]);
    const d = await deposerMessage(u.id, "Fais le rapprochement de la caisse d'avance du mois.", [], null, null);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    await traiterFil(u.id, d.conversation);
    const rep = await prisma.assistantIaTour.findFirstOrThrow({ where: { repondA: d.tour.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
    expect(rep.etat, rep.contenu).toBe(ETAT.TERMINE);
    expect(rep.contenu).toContain("Le rapprochement est prêt.");
    expect(await prisma.assistantIaTour.count({ where: { repondA: d.tour.id, role: "assistant" } })).toBe(1);
  });
});

suite("F2 · TR-LO-01 — deux cartes indépendantes coexistent ; seule une carte remplacée devient caduque (base réelle)", () => {
  let sofiane: CurrentUser;
  beforeAll(async () => { sofiane = await compte("Sofiane", "SUPER_ADMIN"); });
  afterAll(async () => {
    await prisma.task.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { description: { contains: TAG } }] } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: sofiane?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Sofiane` } } }).catch(() => {});
  });
  const tache = async (entree: Record<string, unknown>) => {
    const props: PropositionPreparee[] = [];
    const o = outilsV1(sofiane, props, [], [], null, await accesAssistantIa(sofiane), { capacites: true }).find((t) => t.def.name === "task__createTask")!;
    expect(JSON.parse(await o.run(entree, sofiane)).statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    return props[0]!.intentId;
  };
  const statut = async (id: string) => (await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id } })).status;

  it("le scénario du banc : deux tâches préparées, puis « rappelle-moi… » — les deux cartes restent, les deux se confirment", async () => {
    ACTEUR = sofiane;
    // (L'étiquette du test va dans la description : dans les deux titres, elle ferait elle-même un mot commun.)
    const a = await tache({ title: "Envoyer les échantillons — appel d'offres oncologie CHU Mustapha", description: `Envoyer les échantillons dans le cadre de l'appel d'offres oncologie du CHU Mustapha. ${TAG}`, dueDate: "2026-11-14" });
    const b = await tache({ title: "Relancer le pharmacien chef du CHU Mustapha", description: `Relancer le pharmacien chef au sujet de l'appel d'offres oncologie du CHU Mustapha. ${TAG}`, dueDate: "2026-11-20" });
    expect(await statut(a)).toBe("PROPOSED");
    expect(await retirerCaduquesAvantLeTour(sofiane.id, "Rappelle-moi ce qu'on vient de préparer pour cet appel d'offres.")).toEqual([]);
    expect([await statut(a), await statut(b)]).toEqual(["PROPOSED", "PROPOSED"]);
    for (const id of [a, b]) expect((await confirmerIntentionAssistantIA(id)).ok).toBe(true);
    expect(await prisma.task.count({ where: { description: { contains: TAG } } })).toBe(2);
  });

  it("une carte RÉELLEMENT remplacée (même objet, nouvelle échéance) devient caduque", async () => {
    ACTEUR = sofiane;
    const titre = `Préparer le dossier technique Daclavir ${TAG}`;
    const a = await tache({ title: titre, description: "Pour l'appel d'offres.", dueDate: "2026-11-14" });
    const b = await tache({ title: titre, description: "Pour l'appel d'offres.", dueDate: "2026-11-12" });
    expect([await statut(a), await statut(b)]).toEqual(["CANCELLED", "PROPOSED"]);
  });

  it("l'acte de parole : une question ou un rappel ne corrige rien ; une correction, si", () => {
    expect(estQuestionOuRappel("Rappelle-moi ce qu'on vient de préparer pour cet appel d'offres.")).toBe(true);
    expect(estQuestionOuRappel("Et c'est pour quand déjà ?")).toBe(true);
    expect(estQuestionOuRappel("Non, finalement pas Raihana : c'est Amel.")).toBe(false);
    expect(estQuestionOuRappel("Et ajoute une deuxième tâche : relancer le pharmacien chef le 20.")).toBe(false);
  });
});

suite("F2 · TR-EV-01 — la BU se désigne par son nom (base réelle)", () => {
  let nesrine: CurrentUser;
  let bu: { id: string };
  const nom = `Hépatologie F2${Date.now().toString(36)}`;
  beforeAll(async () => {
    nesrine = await compte("Nesrine", "MEDICAL_PROMOTION_MANAGER");
    await prisma.userAccess.create({ data: { userId: nesrine.id, module: "CONGRESS_NATIONAL", canView: true, canCreate: true, scope: "ALL" } });
    nesrine = { ...nesrine, access: await getAccess(nesrine.id, nesrine.role) } as CurrentUser;
    bu = await prisma.businessUnit.create({ data: { name: nom } });
  });
  afterAll(async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId: nesrine?.id } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: nom } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: nesrine?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Nesrine` } } }).catch(() => {});
  });

  it("« BU Hépatologie » dans la demande de congrès : résolue en la gamme, jamais « quel est l'identifiant de la BU ? »", async () => {
    ACTEUR = nesrine;
    const props: PropositionPreparee[] = [];
    const o = outilsV1(nesrine, props, [], [], null, await accesAssistantIa(nesrine), { capacites: true }).find((t) => t.def.name === "congress-request__createCongressRequest");
    expect(o, "la capacité congrès n'est pas offerte").toBeTruthy();
    const sortie = JSON.parse(await o!.run({ name: "Congrès national d'hépatologie d'Alger", businessUnitId: `BU ${nom}`, date: "2026-12-05", endDate: "2026-12-06", estimatedBudget: 120000 }, nesrine));
    expect(JSON.stringify(sortie)).not.toMatch(/identifiant/i);
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props[0]!.proposition.payload).toMatchObject({ entree: { businessUnitId: bu.id } });
  });
});

suite("F2 · TR-MU-03 — un mail au destinataire introuvable : la carte est préparée, « À » à compléter (base réelle)", () => {
  let meriem: CurrentUser;
  beforeAll(async () => { meriem = await compte("Meriem", "REGULATORY_ASSISTANT"); });
  afterAll(async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId: meriem?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Meriem` } } }).catch(() => {});
  });

  it("jamais « rien n'est préparé » : une carte, le destinataire à compléter ; confirmée sans lui, rien ne part", async () => {
    ACTEUR = meriem;
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(meriem, props, [], [], null, await accesAssistantIa(meriem), { capacites: true });
    const o = outilsMails(meriem, (n) => tous.find((t) => t.def.name === n), props).find((t) => t.def.name === "envoyer_mail");
    expect(o, "envoyer_mail absent").toBeTruthy();
    const sortie = JSON.parse(await o!.run({ mails: [{
      a: `le pharmacien responsable ${TAG}`, objet: "Visite ANPP — actions correctives",
      contenu: { salutation: "Bonjour,", paragraphes: ["Deux actions sont à mener sous 30 jours."], liste: ["Compléter le registre des températures de septembre", "Mettre à jour la procédure de rappel de lot"], cloture: "Bien cordialement," },
    }] }, meriem));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(sortie.a_completer).toBeTruthy();
    expect(props).toHaveLength(1);
    const carte = props[0]!.proposition;
    expect(JSON.stringify(carte.warnings)).toContain("Destinataire à compléter");
    expect(JSON.stringify(carte.payload)).toContain("registre des températures");
    expect((carte.payload as { entree: Record<string, unknown> }).entree.to).toBeUndefined();
    // Le formulaire de la carte porte le champ « À », vide, à saisir.
    expect(carte.formulaire?.champs.some((c) => c.nom === "to")).toBe(true);
    // Le modèle ne peut pas demander une carte incomplète : un champ JSON « à compléter » n'a aucun effet.
    const sans: PropositionPreparee[] = [];
    const cap = outilsV1(meriem, sans, [], [], null, await accesAssistantIa(meriem), { capacites: true }).find((t) => t.def.name === "smart-mail__sendMail");
    if (cap) expect(JSON.parse(await cap.run({ subject: "x", body: "y", "champs à compléter sur la carte": ["to"] }, meriem)).statut).toBe("INCOMPLET");
    // Confirmée sans destinataire : l'action refuse, rien ne part.
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r.ok).toBe(false);
  });
});

suite("F2 · TR-LM-04 — un article hors catalogue est proposé en saisie libre, jamais retiré (base réelle)", () => {
  let yanis: CurrentUser;
  const marque = `F2${Date.now().toString(36)}`;
  beforeAll(async () => {
    yanis = await compte("Yanis", "MEDICAL_DELEGATE");
    await prisma.userAccess.create({ data: { userId: yanis.id, module: "PROMO_MATERIAL", canView: true, canCreate: true, scope: "ASSIGNED" } });
    yanis = { ...yanis, access: await getAccess(yanis.id, yanis.role) } as CurrentUser;
    await prisma.promoCatalogueArticle.create({ data: { reference: `CAT-${marque}`, nom: `Stylos ${marque}`, famille: "CONSOMMABLE", actif: true } });
  });
  afterAll(async () => {
    const dossiers = await prisma.promoMaterial.findMany({ where: { requesterId: yanis?.id }, select: { id: true } });
    await prisma.promoRequestItem.deleteMany({ where: { promoMaterialId: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { requesterId: yanis?.id } }).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { nom: { contains: marque } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: yanis?.id } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: yanis?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${TAG}Yanis` } } }).catch(() => {});
  });

  it("« 3 cartons de brochures » (hors catalogue) et « 2 boîtes de stylos » : deux lignes ; confirmée, la brochure entre en « Autre article »", async () => {
    ACTEUR = yanis;
    const props: PropositionPreparee[] = [];
    const o = outilsV1(yanis, props, [], [], null, await accesAssistantIa(yanis), { capacites: true }).find((t) => t.def.name === "preparer_materiel_promo");
    expect(o, "l'opération n'est pas offerte").toBeTruthy();
    const sortie = JSON.parse(await o!.run({ titre: `Daclavir ${marque}`, articles: [
      { article: `Brochures Daclavir ${marque}`, quantite: "300", actions: ["impression"] },
      { article: `Stylos ${marque}`, quantite: "2" },
    ] }, yanis));
    expect(sortie.statut, JSON.stringify(sortie)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const carte = JSON.stringify(props[0]!.proposition.fields);
    expect(carte).toContain(`Brochures Daclavir ${marque} (saisie libre, hors catalogue) × 300`);
    expect(carte).toContain(`Stylos ${marque}`);
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const dossier = await prisma.promoMaterial.findFirstOrThrow({ where: { requesterId: yanis.id }, include: { articlesDemandes: { include: { catalogue: true } } } });
    expect(dossier.articlesDemandes).toHaveLength(2);
    const libre = dossier.articlesDemandes.find((i) => i.catalogue.nom.startsWith("Brochures"))!;
    expect(libre.catalogue).toMatchObject({ horsCatalogue: true, actif: false, famille: "CONSOMMABLE" });
  });
});
