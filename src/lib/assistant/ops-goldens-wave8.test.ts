import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 8 — FICHIERS FIRST-CLASS : le fichier se donne par NOM (Drive), la
 * proposition le résout et le MONTRE (nom, taille) ; un fichier d'autrui inaccessible reste
 * introuvable ; les formats sont contrôlés AVANT toute lecture (CSV pour l'import, .docx pour
 * un en-tête Word, PDF/image pour l'OCR d'appel d'offres) ; la caisse d'avance exige la pièce ;
 * la papeterie est refusée à un délégué par la porte du catalogue.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops8__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let otherId = "";
let pdfNodeId = "";
let sponsoringId = "";
let cashId = "";
let paymentId = "";
let tenderId = "";
let docRequestId = "";

const sa = () => userWith({
  FINANCES: ["VIEW", "CREATE"], MEDICAL: ["VIEW", "CREATE"], PCH: ["VIEW", "UPDATE"], DRIVE: ["VIEW"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 8 — fichiers first-class", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.medicalInfoDocRequest.deleteMany({ where: { label: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { department: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Sofiane Autre`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; otherId = o.id;

    const [pdf] = await Promise.all([
      prisma.driveNode.create({ data: { name: `${TAG} facture-imprimeur.pdf`, type: "FILE", ownerId: s.id, size: 52_000, mimeType: "application/pdf" } }),
      prisma.driveNode.create({ data: { name: `${TAG} classeur-annuaire.xlsx`, type: "FILE", ownerId: s.id, size: 31_000, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
      prisma.driveNode.create({ data: { name: `${TAG} en-tete-societe.docx`, type: "FILE", ownerId: s.id, size: 24_000 } }),
      // Fichier d'AUTRUI, non partagé : il ne doit JAMAIS se résoudre pour `sa`.
      prisma.driveNode.create({ data: { name: `${TAG} secret-dg.pdf`, type: "FILE", ownerId: o.id, size: 9_000 } }),
    ]);
    pdfNodeId = pdf.id;

    const sponsoring = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}-SPO-1`, institution: `${TAG} CHU Mustapha`, type: "Sponsoring", requesterId: s.id },
    });
    sponsoringId = sponsoring.id;

    const dept = await prisma.department.create({ data: { name: `${TAG} Moyens Generaux`, code: `${TAG}MG` } });
    const cash = await prisma.pettyCashAllotment.create({
      data: { departmentId: dept.id, period: "2033-11", amount: 50_000, status: "RECEIVED", holderId: s.id },
    });
    cashId = cash.id;

    const pay = await prisma.paymentRequest.create({
      data: { reference: `${TAG}-PAY-7`, title: `${TAG} Impression brochures`, amount: 120_000, payee: "Imprimerie du Centre", requesterId: s.id },
    });
    paymentId = pay.id;

    const tender = await prisma.pchTender.create({ data: { reference: `${TAG}-AO-3`, title: `${TAG} Marche oncologie` } });
    tenderId = tender.id;

    const decl = await prisma.medicalInfoDeclaration.create({
      data: { reference: `${TAG}-DIM-1`, sourceType: "SPONSORING", sourceId: sponsoring.id, label: `${TAG} Congres Cardio` },
    });
    const dr = await prisma.medicalInfoDocRequest.create({
      data: { declarationId: decl.id, label: `${TAG} Attestation de presence`, targetUserId: s.id, status: "PENDING" },
    });
    docRequestId = dr.id;
  });


  it("upload_document : le fichier ET l'objet se résolvent par nom — le fichier est montré avec sa taille", async () => {
    const p = await buildProposal("task_operation", {
      op: "upload_document", kind: "SPONSORING", target: `${TAG}-SPO-1`, file: "facture-imprimeur",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).entityId).toBe(sponsoringId);
      expect(domainArgs(p).fileNodeId).toBe(pdfNodeId);
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/facture-imprimeur\.pdf \(/);
    }
  });

  it("le fichier d'AUTRUI ne se résout pas pour qui n'a pas la vue Drive globale ni de partage", async () => {
    // NB : le module DRIVE en portée ALL donne la VUE sur tout le Drive (politique de l'écran) —
    // le cas « pas de fuite » se teste donc SANS ce module, comme un compte à portée restreinte.
    const delegate = userWith({}, "MEDICAL_DELEGATE", otherId, "Sofiane");
    const p = await buildProposal("task_operation", {
      op: "upload_document", kind: "SPONSORING", target: `${TAG}-SPO-1`, file: "facture-imprimeur",
    }, delegate);
    expect("error" in p && p.error).toMatch(/Aucun fichier/);
  });

  it("import_transactions : un classeur .xlsx est refusé (CSV attendu) ; les lignes collées sont comptées", async () => {
    const bad = await buildProposal("finance_operation", {
      op: "import_transactions", file: "classeur-annuaire",
    }, sa());
    expect("error" in bad && bad.error).toMatch(/pas un CSV/);

    const p = await buildProposal("finance_operation", {
      op: "import_transactions",
      note: "date;direction;categorie;libelle;montant\n2033-11-02;OUT;ACHATS;Ramettes papier;12000\n2033-11-03;IN;VENTE;Encaissement;90000",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(p.title).toMatch(/2 mouvement/);
      expect(p.warnings.join(" ")).toMatch(/FIN-AAAA/);
    }
  });

  it("spend_from_petty_cash : MA caisse ouverte se résout, la pièce est OBLIGATOIRE et montrée", async () => {
    // Le DÉTENTEUR de la caisse, sans vue globale : c'est le cas que le titre décrit (« MA
    // caisse »), et c'est le seul qui soit DÉTERMINISTE. Avec une vue globale, l'op balaie
    // TOUTES les caisses ouvertes de la base — y compris celles d'autres suites ou de vraies
    // données — et demande alors, à juste titre, de préciser la période. Ce n'est pas un
    // défaut de l'op : un Super Admin a normalement plusieurs caisses ouvertes. Le test ne
    // doit donc pas parier sur une base vide ailleurs. Même id (donc bien le détenteur),
    // rôle sans vue globale : la requête se borne à `holderId`.
    const holder = () => userWith(
      { FINANCES: ["VIEW", "CREATE"], DRIVE: ["VIEW"] }, "MEDICAL_DELEGATE", saId, `${TAG} Amine`,
    );

    const noFile = await buildProposal("finance_operation", {
      op: "spend_from_petty_cash", label: "Cartouches d'encre", amount: "8000",
    }, holder());
    expect("error" in noFile && noFile.error).toMatch(/Nommez le fichier/);

    const p = await buildProposal("finance_operation", {
      op: "spend_from_petty_cash", label: "Cartouches d'encre", amount: "8000", file: "facture-imprimeur",
    }, holder());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).cashId).toBe(cashId);
      expect(domainArgs(p).amount).toBe("8000");
      expect(p.warnings.join(" ")).toMatch(/OBLIGATOIRE/);
    }
  });

  it("add_payment_piece : la demande se résout par référence PAY, la pièce est rattachée", async () => {
    const p = await buildProposal("finance_operation", {
      op: "add_payment_piece", target: `${TAG}-PAY-7`, file: "facture-imprimeur",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).requestId).toBe(paymentId);
      expect(domainArgs(p).fileNodeId).toBe(pdfNodeId);
    }
  });

  it("import_directory_sheet : le classeur Excel passe, un PDF est refusé", async () => {
    const p = await buildProposal("medical_operation", {
      op: "import_directory_sheet", file: "classeur-annuaire",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/colonne « Nom » requise/i);

    const bad = await buildProposal("medical_operation", {
      op: "import_directory_sheet", file: "facture-imprimeur",
    }, sa());
    expect("error" in bad && bad.error).toMatch(/ni un classeur/);
  });

  it("fulfill_doc_request : la pièce qui M'est demandée se résout ; un autre n'a rien en attente", async () => {
    const p = await buildProposal("medical_info_operation", {
      op: "fulfill_doc_request", label: "Attestation", file: "facture-imprimeur",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).requestId).toBe(docRequestId);
      expect(p.warnings.join(" ")).toMatch(/notifie le demandeur/);
    }

    const none = await buildProposal("medical_info_operation", {
      op: "fulfill_doc_request", label: "Attestation", file: "x",
    }, userWith({}, "MEDICAL_DELEGATE", otherId, "Sofiane"));
    expect("error" in none && none.error).toMatch(/Aucune pièce/);
  });

  it("analyze_tender_document : marché par référence, PDF accepté, .docx refusé pour l'OCR", async () => {
    const p = await buildProposal("pch_operation", {
      op: "analyze_tender_document", target: `${TAG}-AO-3`, file: "facture-imprimeur",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).tenderId).toBe(tenderId);
      expect(p.warnings.join(" ")).toMatch(/OCR/);
    }

    const bad = await buildProposal("pch_operation", {
      op: "analyze_tender_document", target: `${TAG}-AO-3`, file: "en-tete-societe",
    }, sa());
    expect("error" in bad && bad.error).toMatch(/non pris en charge/);
  });

  it("upload_letterhead : porte catalogue (délégué refusé) ; extension .docx exigée pour Word", async () => {
    const denied = await buildProposal("org_operation", {
      op: "upload_letterhead", kind: "word", file: "x",
    }, userWith({}, "MEDICAL_DELEGATE", otherId, "Sofiane"));
    expect("error" in denied && denied.error).toMatch(/droit/);

    const badExt = await buildProposal("org_operation", {
      op: "upload_letterhead", kind: "word", file: "facture-imprimeur",
    }, sa());
    expect("error" in badExt && badExt.error).toMatch(/\.docx/);

    const p = await buildProposal("org_operation", {
      op: "upload_letterhead", kind: "word", file: "en-tete-societe",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/TOUS les documents/);
  });
});
