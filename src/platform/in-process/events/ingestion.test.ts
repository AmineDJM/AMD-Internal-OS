import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { avancer } from "@/lib/missions/runtime/engine";
import { chargerEtat, materialiser } from "@/lib/missions/runtime/store";
import { compile } from "@/lib/missions/compiler/compile";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import { refusPourActeur } from "@/lib/missions/policy/guard";
import { consignerMesure } from "@/lib/evals/registre";
import { autoriser, ingerer, listerEvenementsRecus, rattacherEvenement, resumeIngestion, secretPour, signer } from "./ingestion";
import { POST } from "@/app/api/events/inbound/[source]/route";

/**
 * L'INGESTION UNIVERSELLE (§37), de bout en bout, par les VRAIS points d'entrée : la route signée,
 * la réclamation exactly-once, l'association par la résolution d'entités, le registre, et le
 * RÉVEIL d'une mission qui attendait le fait — sans que personne dise « c'est signé ».
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ing${Date.now().toString(36)}`;
const SECRET = `s3cret-${TAG}`;
let owner: CurrentUser;
let actor: MissionActor;
let docId = "";
let heteroLabsId = "";
let heteroBioId = "";

const CONNUES = ["send_message", "inspect_record", "create_task"];
const catalogue: CapabilityCatalog = { has: (n) => CONNUES.includes(n), allowed: () => true, meta: (n) => capabilityMeta(n), brief: () => [] };
const traceur = () => {
  const appels: CapabilityCall[] = [];
  return { appels, runner: { async run(call: CapabilityCall): Promise<CapabilityOutcome> { appels.push(call); return { ok: true, output: { ok: true } }; } } };
};
async function creerMission(steps: PlannedStep[], titre: string) {
  const plan: MissionPlan = { objective: titre, acceptance: ["fait"], complexity: "B", scale: "S", steps };
  const r = compile(plan, catalogue, actor);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join(" | "));
  return materialiser(r.mission, { ownerId: owner.id, title: titre, goalRaw: titre });
}
const docusign = (envelopeId: string, event: string, erpRef: string | null, sujet: string, signataire = "Karim Mouffok") => ({
  event, data: {
    envelopeId, envelopeSummary: {
      status: event.replace("envelope-", ""), emailSubject: sujet, completedDateTime: "2026-09-01T10:00:00Z",
      recipients: { signers: [{ name: signataire, email: "k@mouffok.dz", status: "completed" }] },
      ...(erpRef ? { customFields: { textCustomFields: [{ name: "erpRef", value: erpRef }] } } : {}),
    },
  },
});

suite("ingestion universelle — autoriser, dédoublonner, associer, inscrire, réveiller", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    owner = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    actor = { userId: u.id, label: "le PDG", isAgent: false };
    docId = `ckdoc${TAG.replace(/[^a-z0-9]/g, "")}`;
    const a = await prisma.supplier.create({ data: { name: `${TAG} Hetero Labs Ltd`, country: "IN" }, select: { id: true } });
    const b = await prisma.supplier.create({ data: { name: `${TAG} Hetero Biopharma`, country: "IN" }, select: { id: true } });
    heteroLabsId = a.id; heteroBioId = b.id;
    process.env.EVENTS_WEBHOOK_SECRET_DOCUSIGN = SECRET;
    process.env.EVENTS_WEBHOOK_SECRET_GENERIC = SECRET;
    delete process.env.EVENTS_WEBHOOK_SECRET_SAP;
  }, 60_000);

  afterAll(async () => {
    delete process.env.EVENTS_WEBHOOK_SECRET_DOCUSIGN;
    delete process.env.EVENTS_WEBHOOK_SECRET_GENERIC;
    await prisma.ingestedEvent.deleteMany({ where: { OR: [{ externalId: { contains: TAG } }, { payload: { path: ["subject"], string_contains: TAG } }, { payload: { path: ["fournisseur"], string_contains: TAG } }] } }).catch(() => {});
    await prisma.businessEvent.deleteMany({ where: { correlationId: { contains: TAG } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: owner.id } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: owner.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
  }, 60_000);

  it("autoriser : source inconnue 400, sans secret 503, signature fausse 401, signature juste OK — et le secret propre prime sur le commun", () => {
    const corps = JSON.stringify({ type: "PAYMENT_RECEIVED", id: "x" });
    expect(autoriser("fax", corps, signer(corps, SECRET))).toMatchObject({ ok: false, statut: 400 });
    expect(autoriser("sap", corps, signer(corps, SECRET), { EVENTS_WEBHOOK_SECRET_DOCUSIGN: SECRET })).toMatchObject({ ok: false, statut: 503 });
    expect(autoriser("generic", corps, "sha256=deadbeef")).toMatchObject({ ok: false, statut: 401 });
    expect(autoriser("generic", corps, null)).toMatchObject({ ok: false, statut: 401 });
    expect(autoriser("generic", corps, signer(corps, SECRET))).toEqual({ ok: true, source: "generic" });
    expect(autoriser("generic", `${corps} `, signer(corps, SECRET))).toMatchObject({ ok: false, statut: 401 });
    expect(secretPour("sap", { EVENTS_WEBHOOK_SECRET: "commun", EVENTS_WEBHOOK_SECRET_SAP: "propre" })).toBe("propre");
    expect(secretPour("pch", { EVENTS_WEBHOOK_SECRET: "commun" })).toBe("commun");
    expect(secretPour("pch", {})).toBeNull();
  });

  it("la mission dort sur « la signature DU contrat » ; l'enveloppe DocuSign complète arrive, référencée : ACCEPTED, un fait au registre, la mission repart — et la relivraison est un DOUBLON sans second fait", async () => {
    const id = await creerMission([
      { key: "envoi", title: "Envoyer à signer", capability: "send_message", input: { to: "karim" } },
      { key: "attente", title: "Signature du contrat", nodeType: "WAIT_EVENT", dependsOn: ["envoi"], waitFor: { event: "SIGNATURE_COMPLETED", entity: `LEGAL_DOCUMENT:${docId}`, withinDays: 10 } },
      { key: "suite", title: "Archiver", capability: "inspect_record", dependsOn: ["attente"] },
    ], `${TAG} contrat Mouffok`);
    const t1 = traceur();
    expect((await avancer(id, actor, { runner: t1.runner })).status).toBe("WAITING_EVENT");

    // Une AUTRE enveloppe complète, sans référence : elle n'est pas CE contrat — la mission ne bouge pas.
    const autre = await ingerer("docusign", docusign(`env-autre-${TAG}`, "envelope-completed", null, `${TAG} NDA sans rapport`, "Personne Inconnue"));
    expect(autre.faits[0]!.statut).toMatch(/ACCEPTED|SANS_ASSOCIATION/);
    expect((await chargerEtat(id))!.steps.find((s) => s.key === "attente")!.status).toBe("WAITING");

    const t0 = Date.now();
    const r = await ingerer("docusign", docusign(`env-${TAG}`, "envelope-completed", `LEGAL_DOCUMENT:${docId}`, `${TAG} Contrat Consulting Mouffok`));
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ recus: 1, acceptes: 1, doublons: 0, rejetes: 0 });
    const fait = r.faits[0]!;
    expect(fait).toMatchObject({ type: "SIGNATURE_COMPLETED", statut: "ACCEPTED", refs: [`LEGAL_DOCUMENT:${docId}`], confiance: 1 });
    expect(fait.businessEventId).toBeTruthy();
    const evt = await prisma.businessEvent.findUnique({ where: { id: fait.businessEventId! } });
    expect(evt).toMatchObject({ type: "SIGNATURE_COMPLETED", sourceDomain: "LEGAL", entityType: "LEGAL_DOCUMENT", entityId: docId, correlationId: `docusign:env-${TAG}:envelope-completed` });
    expect(JSON.stringify(evt!.payload)).not.toMatch(/token|secret/i);

    // LA MISSION S'EST RÉVEILLÉE — la suite s'exécute, et le fait qui l'a réveillée est conservé.
    const t2 = traceur();
    const r2 = await avancer(id, actor, { runner: t2.runner });
    expect(t2.appels.map((a) => a.stepKey)).toEqual(["suite"]);
    expect(r2.executees).toBe(1);
    const etat = await chargerEtat(id);
    expect((etat!.steps.find((s) => s.key === "attente")!.result as { reveillePar: string }).reveillePar).toBe("SIGNATURE_COMPLETED");

    // LA RELIVRAISON : le fournisseur réessaie — un doublon, aucun second fait au registre.
    const avant = await prisma.businessEvent.count({ where: { correlationId: `docusign:env-${TAG}:envelope-completed` } });
    const bis = await ingerer("docusign", docusign(`env-${TAG}`, "envelope-completed", `LEGAL_DOCUMENT:${docId}`, `${TAG} Contrat Consulting Mouffok`));
    expect(bis).toMatchObject({ recus: 1, doublons: 1, acceptes: 0 });
    expect(bis.faits[0]!.businessEventId).toBe(fait.businessEventId);
    expect(await prisma.businessEvent.count({ where: { correlationId: `docusign:env-${TAG}:envelope-completed` } })).toBe(avant);

    consignerMesure("ingestion_reveil_mission", { n: 1, ok: 1 }, "platform/in-process/events/ingestion.test.ts", `DocuSign envelope-completed → SIGNATURE_COMPLETED → mission WAIT_EVENT réveillée en ${ms} ms, relivraison dédoublonnée`);
  }, 60_000);

  it("deux livraisons SIMULTANÉES du même fait : une seule inscrite, l'autre doublon — la réclamation précède la conséquence", async () => {
    const charge = docusign(`env-race-${TAG}`, "envelope-declined", null, `${TAG} Avenant refusé`);
    const [a, b] = await Promise.all([ingerer("docusign", charge), ingerer("docusign", charge)]);
    const statuts = [a.faits[0]!.statut, b.faits[0]!.statut].sort();
    expect(statuts).toEqual(["ACCEPTED", "DUPLICATE"].sort());
    expect(await prisma.businessEvent.count({ where: { correlationId: `docusign:env-race-${TAG}:envelope-declined` } })).toBe(1);
  }, 60_000);

  it("une mention AMBIGUË (deux fournisseurs « Hetero ») : le fait entre À VÉRIFIER, sans référence, avec ses candidats ; la mission qui attend CE fournisseur ne bouge pas ; une personne rattache, la mission repart", async () => {
    const id = await creerMission([
      { key: "attente", title: "Livraison Hetero Labs", nodeType: "WAIT_EVENT", waitFor: { event: "SUPPLIER_DELIVERY_UPDATED", entity: `SUPPLIER:${heteroLabsId}`, withinDays: 30 } },
      { key: "suite", title: "Contrôler la réception", capability: "inspect_record", dependsOn: ["attente"] },
    ], `${TAG} livraison Hetero`);
    expect((await avancer(id, actor, { runner: traceur().runner })).status).toBe("WAITING_EVENT");

    const r = await ingerer("sap", { event: "delivery.updated", eventId: `sap-liv-${TAG}`, PurchaseOrder: "4500007777", Supplier: `${TAG} Hetero`, status: "shipped" });
    const f = r.faits[0]!;
    expect(f.type).toBe("SUPPLIER_DELIVERY_UPDATED");
    expect(f.statut).toBe("A_VERIFIER");
    expect(f.refs).toEqual([]);
    expect(f.aVerifier.map((c) => c.ref).sort()).toEqual([`SUPPLIER:${heteroBioId}`, `SUPPLIER:${heteroLabsId}`].sort());
    expect(f.aVerifier.every((c) => c.confiance >= 0.5 && c.confiance < 0.85)).toBe(true);
    expect((await chargerEtat(id))!.steps.find((s) => s.key === "attente")!.status).toBe("WAITING");

    const liste = await listerEvenementsRecus({ source: "sap", statut: "A_VERIFIER" });
    const ligne = liste.find((l) => l.externalId === `sap-liv-${TAG}`)!;
    expect(ligne).toBeTruthy();
    expect(ligne.candidats).toHaveLength(2);
    expect(ligne.raison).toMatch(/à rattacher par une personne/);
    expect(ligne.resume).toMatchObject({ numero: "4500007777" });
    expect((await resumeIngestion(new Date(Date.now() - 60_000))).A_VERIFIER).toBeGreaterThanOrEqual(1);

    // Un compte SANS vue globale ne rattache rien ; une référence mal formée non plus.
    const lecteur = { ...owner, role: "VIEWER", access: (await getAccess(owner.id, "VIEWER")) as EffectiveAccess } as CurrentUser;
    expect(await rattacherEvenement(lecteur, { id: ligne.id, ref: `SUPPLIER:${heteroLabsId}` })).toMatchObject({ ok: false });
    expect(await rattacherEvenement(owner, { id: ligne.id, ref: "Hetero Labs" })).toMatchObject({ ok: false });

    const ok = await rattacherEvenement(owner, { id: ligne.id, ref: `SUPPLIER:${heteroLabsId}` });
    expect(ok).toMatchObject({ ok: true, refs: [`SUPPLIER:${heteroLabsId}`], reveils: [{ missionId: id, stepKey: "attente" }] });
    const apres = await prisma.ingestedEvent.findUnique({ where: { id: ligne.id } });
    expect(apres).toMatchObject({ status: "ACCEPTED", confidence: 1, refs: [`SUPPLIER:${heteroLabsId}`] });
    const evt = await prisma.businessEvent.findUnique({ where: { id: apres!.businessEventId! } });
    expect(evt).toMatchObject({ entityType: "SUPPLIER", entityId: heteroLabsId, relatedRefs: [`SUPPLIER:${heteroLabsId}`] });
    const t = traceur();
    await avancer(id, actor, { runner: t.runner });
    expect(t.appels.map((a) => a.stepKey)).toEqual(["suite"]);
    // L'agent n'a pas ce geste : un document lu ne rattache rien.
    expect(refusPourActeur("attach_inbound_event", "INTERNAL_REVERSIBLE_WRITE", { userId: owner.id, label: "adam", isAgent: true })).not.toBeNull();
    consignerMesure("ingestion_ambiguite_verifiee", { n: 1, ok: 1 }, "platform/in-process/events/ingestion.test.ts", "mention ambiguë → A_VERIFIER (2 candidats) → rattachement humain → mission réveillée");
  }, 60_000);

  it("la ROUTE : 401 sans signature juste, 503 sans secret, 400 hors JSON ou source inconnue, 200 avec des comptes — et une charge rejetée est comptée, pas perdue", async () => {
    const appel = (source: string, corps: string, signature: string | null) => POST(new Request(`http://local/api/events/inbound/${source}`, { method: "POST", body: corps, headers: signature ? { "x-webhook-signature": signature, "content-type": "application/json" } : { "content-type": "application/json" } }), { params: Promise.resolve({ source }) });
    const corps = JSON.stringify({ type: "PAYMENT_RECEIVED", externalId: `pay-${TAG}`, entity: { type: "INVOICE", id: `ckinv${TAG.replace(/[^a-z0-9]/g, "")}` }, from: { email: "banque@x.dz" }, payload: { montant: 1000 } });
    expect((await appel("generic", corps, "sha256=00")).status).toBe(401);
    expect((await appel("generic", corps, null)).status).toBe(401);
    expect((await appel("sap", corps, signer(corps, SECRET))).status).toBe(503);
    expect((await appel("fax", corps, signer(corps, SECRET))).status).toBe(400);
    expect((await appel("generic", "pas du json", signer("pas du json", SECRET))).status).toBe(400);
    const ok = await appel("generic", corps, signer(corps, SECRET));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, recus: 1, acceptes: 1, doublons: 0, rejetes: 0 });
    const rejoue = await appel("generic", corps, signer(corps, SECRET));
    expect(await rejoue.json()).toMatchObject({ ok: true, recus: 1, doublons: 1 });
    const rejet = JSON.stringify({ pas: "de type", ref: TAG });
    const rr = await appel("generic", rejet, signer(rejet, SECRET));
    expect(await rr.json()).toMatchObject({ ok: true, rejetes: 1 });
    const ligne = await prisma.ingestedEvent.findFirst({ where: { source: "generic", status: "REJECTED", payload: { path: ["ref"], equals: TAG } } });
    expect(ligne?.reason).toMatch(/type/);
    expect((await listerEvenementsRecus({ source: "generic", statut: "REJECTED", limite: 50 })).some((l) => l.id === ligne?.id)).toBe(true);
  }, 60_000);
});
