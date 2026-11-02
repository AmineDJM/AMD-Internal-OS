/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TEACH ADAM, SUR UNE VRAIE BASE ET PAR LES VRAIS POINTS D'ENTRÉE — les outils qu'Adam appelle
 * (`executePowerTool`), le contexte personnel que la conversation et la voix lisent
 * (`personalContext`), les politiques que le planificateur reçoit, le profil que la fabrique de
 * documents applique. Pas d'état injecté à la main (§14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consignerMesure } from "@/lib/evals/registre";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { personalContext } from "@/lib/assistant-memory";
import { politiquesPourMission, reglesEnVigueurPour } from "@/platform/ia/teach/store";
import { profilDocumentaire } from "@/platform/ia/artifact/factory";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__teach__${Date.now()}`;
let pdg: CurrentUser;
let emp: CurrentUser;
let companyId = "";

async function utilisateur(suffixe: string, role: "SUPER_ADMIN" | "SALES_USER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${suffixe}`, email: `${TAG}${suffixe}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
}
const appel = async (nom: string, input: Record<string, unknown>, user: CurrentUser) => JSON.parse((await executePowerTool(nom, input, user)) ?? "{}") as Record<string, never> & Record<string, unknown>;

suite("Teach Adam — enseigner, retrouver, départager, réviser, supprimer", () => {
  beforeAll(async () => {
    pdg = await utilisateur("pdg", "SUPER_ADMIN");
    emp = await utilisateur("emp", "SALES_USER");
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) } });
    companyId = c.id;
    await prisma.userCompanyAccess.create({ data: { userId: emp.id, companyId, canEdit: false } });
  }, 60_000);

  afterAll(async () => {
    await prisma.adamRule.deleteMany({ where: { ownerId: { in: [pdg.id, emp.id] } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("une personne s'enseigne une préférence : classée, enregistrée, et lue dans SON contexte personnel", async () => {
    const r = await appel("teach_adam", { statement: "Je préfère les synthèses en trois points, jamais plus de dix lignes." }, emp);
    expect(r.fait, JSON.stringify(r)).toBe(true);
    const regle = r.regle as { id: string; nature: string; perimetre: string; version: number };
    expect(regle.perimetre).toBe("PERSON");
    expect(regle.nature).toBe("PREFERENCE");
    expect(regle.version).toBe(1);
    const ctx = await personalContext(emp.id);
    expect(ctx).toContain("RÈGLES ENSEIGNÉES À ADAM");
    expect(ctx).toContain("synthèses en trois points");
    expect(ctx).toContain(regle.id);
    // Le PDG ne voit PAS la préférence personnelle d'un autre.
    expect(await personalContext(pdg.id)).not.toContain("synthèses en trois points");
  }, 60_000);

  it("une règle de SOCIÉTÉ : refusée à qui ne peut pas légiférer, posée par le PDG, vue et respectée par le salarié", async () => {
    const refus = await appel("teach_adam", { statement: "Désormais les devis sont valables 30 jours", scope: "COMPANY", societe: companyId }, emp);
    expect(refus.fait).toBe(false);
    expect(refus.echec).toBe("MISSING_PERMISSION");
    const ok = await appel("teach_adam", { statement: "Désormais les devis sont valables 30 jours", scope: "COMPANY", societe: companyId, domaine: "documents" }, pdg);
    expect(ok.fait, JSON.stringify(ok)).toBe(true);
    const regle = ok.regle as { id: string; nature: string; params: Record<string, unknown> | null; societe: string | null };
    expect(regle.nature).toBe("DOCUMENT_STANDARD");
    expect(regle.params).toEqual({ cle: "validiteDevis", valeur: 30, unite: "jours" });
    expect(regle.societe).toBe(`${TAG} Pharma`);
    // Le salarié de la société la voit en vigueur, et son contexte la porte.
    const liste = await appel("list_rules", { domaine: "documents" }, emp);
    const vue = (liste.regles as { id: string; enVigueur: boolean }[]).find((x) => x.id === regle.id);
    expect(vue?.enVigueur).toBe(true);
    expect(await personalContext(emp.id)).toContain("valables 30 jours");
    // Le planificateur de missions la reçoit.
    const politiques = await politiquesPourMission(emp.id);
    expect(politiques.some((p) => p.includes("valables 30 jours") && p.includes(regle.id))).toBe(true);
  }, 60_000);

  it("un conflit de même clé est DIT avant d'écrire ; `remplaceId` crée la version 2 et garde la v1 lisible", async () => {
    const conflit = await appel("teach_adam", { statement: "Les devis sont valables 45 jours", scope: "COMPANY", societe: companyId, domaine: "documents" }, pdg);
    expect(conflit.fait).toBe(false);
    const conflits = conflit.conflits as { id: string; regle: string; version: number }[];
    expect(conflits).toHaveLength(1);
    expect(conflits[0].regle).toContain("30 jours");
    const v2 = await appel("teach_adam", { statement: "Les devis sont valables 45 jours", scope: "COMPANY", societe: companyId, domaine: "documents", remplaceId: conflits[0].id }, pdg);
    expect(v2.fait, JSON.stringify(v2)).toBe(true);
    const regle = v2.regle as { id: string; version: number; remplace: string | null; params: Record<string, unknown> };
    expect(regle.version).toBe(2);
    expect(regle.remplace).toBe(conflits[0].id);
    expect(regle.params).toEqual({ cle: "validiteDevis", valeur: 45, unite: "jours" });
    const histo = await appel("list_rules", { id: regle.id, historique: true }, pdg);
    const versions = (histo.regles as { id: string; version: number; statut: string; enVigueur: boolean }[]).sort((a, b) => a.version - b.version);
    expect(versions.map((x) => [x.version, x.statut, x.enVigueur])).toEqual([[1, "SUPERSEDED", false], [2, "ACTIVE", true]]);
    // Le contexte du salarié suit : 45, plus 30.
    const ctx = await personalContext(emp.id);
    expect(ctx).toContain("valables 45 jours");
    expect(ctx).not.toContain("valables 30 jours");
  }, 60_000);

  it("la précédence est celle du code : une préférence personnelle précise un standard, mais ne bat pas une règle de validation de société", async () => {
    const perso = await appel("teach_adam", { statement: "Pour mes devis, 10 jours de validité suffisent", kind: "PREFERENCE", domaine: "documents", params: { cle: "validiteDevis", valeur: 10, unite: "jours" } }, emp);
    expect(perso.fait, JSON.stringify(perso)).toBe(true);
    const liste = await appel("list_rules", { domaine: "documents" }, emp);
    const regles = liste.regles as { id: string; regle: string; enVigueur: boolean; ecarteePar: { id: string; raison: string } | null }[];
    const standard = regles.find((x) => x.regle.includes("45 jours"))!;
    const pref = regles.find((x) => x.regle.includes("10 jours"))!;
    expect(pref.enVigueur).toBe(true);
    expect(standard.enVigueur).toBe(false);
    expect(standard.ecarteePar).toMatchObject({ id: pref.id, raison: expect.stringMatching(/plus étroit/) });

    const validation = await appel("teach_adam", { statement: "Toute facture au-dessus de 500 000 DZD doit être validée par le PDG", scope: "COMPANY", societe: companyId, domaine: "finance", params: { cle: "seuilFacture", seuil: 500_000 } }, pdg);
    expect(validation.fait, JSON.stringify(validation)).toBe(true);
    expect((validation.regle as { nature: string }).nature).toBe("VALIDATION_RULE");
    const contournement = await appel("teach_adam", { statement: "Je préfère envoyer mes factures directement, sans validation", kind: "PREFERENCE", domaine: "finance", params: { cle: "seuilFacture" } }, emp);
    expect(contournement.fait).toBe(true);
    const { resolution } = await reglesEnVigueurPour(emp.id);
    const gagnante = resolution.enVigueur.find((r) => r.params?.cle === "seuilFacture")!;
    expect(gagnante.scope).toBe("COMPANY");
    expect(resolution.ecartees.some((e) => e.regle.statement.includes("sans validation") && /contraignante/.test(e.raison))).toBe(true);
  }, 60_000);

  it("désactiver, réactiver, supprimer : rien ne se perd, et une règle supprimée ne s'applique plus", async () => {
    const r = await appel("teach_adam", { statement: "On écrit les dates en dd/mm/aaaa dans tous les documents", domaine: "documents" }, emp);
    const id = (r.regle as { id: string }).id;
    expect(await personalContext(emp.id)).toContain("dd/mm/aaaa");
    const off = await appel("disable_rule", { id, motif: "essai" }, emp);
    expect(off.fait).toBe(true);
    expect(await personalContext(emp.id)).not.toContain("dd/mm/aaaa");
    const on = await appel("disable_rule", { id, reactiver: true }, emp);
    expect(on.fait).toBe(true);
    expect(await personalContext(emp.id)).toContain("dd/mm/aaaa");
    const del = await appel("delete_rule", { id, motif: "plus d'actualité" }, emp);
    expect(del.fait).toBe(true);
    expect(await personalContext(emp.id)).not.toContain("dd/mm/aaaa");
    const sans = await appel("list_rules", { texte: "dd/mm" }, emp);
    expect(sans.total).toBe(0);
    const avec = await appel("list_rules", { texte: "dd/mm", historique: true }, emp);
    expect((avec.regles as { id: string; statut: string }[]).find((x) => x.id === id)?.statut).toBe("DELETED");
    // Un autre ne touche pas à une règle personnelle qui n'est pas la sienne.
    const intrus = await appel("delete_rule", { id }, pdg);
    expect(intrus.fait).toBe(false);
  }, 60_000);

  it("« finalement 60 jours » : update_rule écrit la v3 sans perdre les précédentes", async () => {
    const liste = await appel("list_rules", { domaine: "documents", scope: "COMPANY" }, pdg);
    const v2 = (liste.regles as { id: string; regle: string; version: number }[]).find((x) => x.regle.includes("45 jours") && x.version === 2)!;
    const r = await appel("update_rule", { id: v2.id, statement: "Les devis sont valables 60 jours", params: { cle: "validiteDevis", valeur: 60, unite: "jours" }, motif: "décision du comité" }, pdg);
    expect(r.fait, JSON.stringify(r)).toBe(true);
    const v3 = r.regle as { id: string; version: number; remplace: string };
    expect(v3.version).toBe(3);
    expect(v3.remplace).toBe(v2.id);
    const histo = await appel("list_rules", { id: v3.id, historique: true }, pdg);
    expect((histo.regles as { version: number }[]).map((x) => x.version).sort()).toEqual([1, 2, 3]);
  }, 60_000);

  it("la fabrique de documents applique le standard enseigné : « nos factures commencent par FAC »", async () => {
    const r = await appel("teach_adam", { statement: "Nos factures commencent par FAC", scope: "COMPANY", societe: companyId, domaine: "documents" }, pdg);
    expect(r.fait, JSON.stringify(r)).toBe(true);
    expect((r.regle as { params: unknown }).params).toEqual({ cle: "prefixeFacture", valeur: "FAC" });
    const p = await profilDocumentaire(pdg, companyId);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.profil.reglages.invoicePrefix).toBe("FAC");
    expect(p.profil.reglages.quoteValidityDays).toBe(60);
    expect(p.profil.reglesAppliquees.map((x) => x.cle).sort()).toEqual(["prefixeFacture", "validiteDevis"]);
  }, 60_000);

  it("une règle à date d'effet future n'est pas encore en vigueur, mais elle existe", async () => {
    const annee = new Date().getUTCFullYear() + 1;
    const r = await appel("teach_adam", { statement: "À partir de l'an prochain, les rapports mensuels partent le 3", effectiveFrom: `${annee}-01-01` }, emp);
    expect(r.fait).toBe(true);
    const liste = await appel("list_rules", { texte: "rapports mensuels" }, emp);
    expect((liste.regles as { enVigueur: boolean }[])[0].enVigueur).toBe(false);
    expect(await personalContext(emp.id)).not.toContain("rapports mensuels");
  }, 60_000);

  it("100 % des règles sont en base — versions remplacées et supprimées comprises — indépendamment de toute mémoire de processus", async () => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "AdamRule" WHERE "ownerId" IN (${pdg.id}, ${emp.id})`;
    // emp : préférence, pref 10 jours, contournement, dd/mm (supprimée), rapports futurs = 5 ; pdg : v1, v2, v3, validation, FAC = 5.
    expect(Number(rows[0].n)).toBe(10);
    consignerMesure("regles_versionnees", { n: 10, ok: Math.min(10, Number(rows[0].n)) }, "platform/in-process/teach/store.test.ts");
    const statuts = await prisma.adamRule.groupBy({ by: ["status"], where: { ownerId: { in: [pdg.id, emp.id] } }, _count: true });
    const parStatut = Object.fromEntries(statuts.map((s) => [s.status, s._count]));
    expect(parStatut).toEqual({ ACTIVE: 7, SUPERSEDED: 2, DELETED: 1 });
  }, 60_000);

  it("les règles s'appliquent SANS le drapeau « mémoire » : le repli de la conversation porte le bloc de règles, et rien d'autre", async () => {
    const { contexteReglesSeules } = await import("@/lib/assistant-memory");
    const sansRegle = await utilisateur("vierge", "SALES_USER");
    const avecRegle = await utilisateur("regle", "SALES_USER");
    const r = await appel("teach_adam", { statement: "Je préfère qu'on me réponde en trois lignes maximum." }, avecRegle);
    expect(r.fait, JSON.stringify(r)).toBe(true);
    const bloc = await contexteReglesSeules(avecRegle.id);
    expect(bloc).not.toBeNull();
    expect(bloc).toContain("RÈGLES ENSEIGNÉES À ADAM");
    expect(bloc).toContain("trois lignes maximum");
    // Rien d'autre que les règles : ni identité, ni souvenirs.
    expect(bloc).not.toMatch(/souvenirs?|mémoire distillée|rattachement/i);
    // Un compte sans règle : null, pas un bloc vide qui coûterait des jetons.
    expect(await contexteReglesSeules(sansRegle.id)).toBeNull();
    // Et les DEUX portes de conversation utilisent ce repli quand la mémoire n'est pas activée —
    // c'est ce qui rend une règle « pour toute la société » effective pour tout le monde.
    const fs = await import("node:fs");
    const route = fs.readFileSync("src/app/api/assistant/stream/route.ts", "utf8");
    const action = fs.readFileSync("src/lib/actions/assistant-actions.ts", "utf8");
    expect(route).toMatch(/memoryOn \? personalBrut : await contexteReglesSeules\(user\.id\)/);
    expect(action).toMatch(/memoryOn \? await personalContext\(user\.id\)\.catch\(sansBloquer\("[^"]+", null\)\) : await contexteReglesSeules\(user\.id\)/);
  }, 60_000);

  it("les paramètres écrits par le modèle sont normalisés : « validite_devis » / « 45 jours » deviennent la clé et le nombre que la fabrique applique", async () => {
    // Une société VIERGE de toute règle : le test précédent a laissé une validité de 60 jours
    // en vigueur sur l'autre, et c'est la normalisation qu'on mesure ici, pas la précédence.
    const c2 = await prisma.company.create({ data: { name: `${TAG} Pharma 2`, shortName: `${TAG.slice(0, 10)}2` } });
    const r = await appel("teach_adam", { statement: "Pour toute la société, les devis sont valables 45 jours.", scope: "COMPANY", societe: c2.id, params: { cle: "validite_devis", valeur: "45 jours", unite: "jours" } }, pdg);
    expect(r.fait, JSON.stringify(r)).toBe(true);
    const id = (r.regle as { id: string }).id;
    const row = await prisma.adamRule.findUnique({ where: { id } });
    expect(row?.params).toEqual({ cle: "validiteDevis", valeur: 45, unite: "jours" });
    const prof = await profilDocumentaire(pdg, c2.id);
    expect(prof.ok).toBe(true);
    if (prof.ok) {
      expect(prof.profil.reglages.quoteValidityDays).toBe(45);
      expect(prof.profil.reglesAppliquees.some((a) => a.id === id)).toBe(true);
    }
    // Et une société SANS règle ni profil garde les défauts (30 jours) : appliquer un standard à
    // une société ne doit jamais écrire dans les défauts partagés du processus.
    const c3 = await prisma.company.create({ data: { name: `${TAG} Pharma 3`, shortName: `${TAG.slice(0, 10)}3` } });
    const vierge = await profilDocumentaire(pdg, c3.id);
    expect(vierge.ok).toBe(true);
    if (vierge.ok) {
      expect(vierge.profil.reglages.quoteValidityDays).toBe(30);
      expect(vierge.profil.reglesAppliquees).toEqual([]);
    }
    await prisma.adamRule.deleteMany({ where: { companyId: c2.id } });
    await prisma.company.delete({ where: { id: c2.id } });
    await prisma.company.delete({ where: { id: c3.id } });
  }, 60_000);
});

describe("normalisation — la forme plate du modèle", () => {
  it("« { validiteDevis: 45, unite: 'jours' } » devient « { cle: validiteDevis, valeur: 45, unite } »", async () => {
    const { normaliserParams } = await import("@/platform/ia/teach/store");
    expect(normaliserParams({ validiteDevis: 45, unite: "jours" }, null)).toEqual({ cle: "validiteDevis", valeur: 45, unite: "jours" });
    expect(normaliserParams({ validite_devis: "45 jours" }, null)).toEqual({ cle: "validiteDevis", valeur: 45 });
    // Deux clés connues à plat : on ne devine pas laquelle porte la règle.
    expect(normaliserParams({ validiteDevis: 45, tvaDefaut: 19 }, null)).toEqual({ validiteDevis: 45, tvaDefaut: 19 });
    // Le niveau de brief de réunion (§32) : la forme plate du modèle (`niveau`) est une variante connue ;
    // une forme plate SANS clé connue s'efface devant le texte quand le texte porte la clé.
    expect(normaliserParams({ niveau: "chef de cabinet" }, null)).toEqual({ cle: "niveauReunion", valeur: "CHIEF_OF_STAFF" });
    expect(normaliserParams({ niveau: "CHIEF_OF_STAFF" }, null)).toEqual({ cle: "niveauReunion", valeur: "CHIEF_OF_STAFF" });
    expect(normaliserParams({ cle: "niveau_reunion", valeur: "light" }, null)).toEqual({ cle: "niveauReunion", valeur: "LIGHT" });
    expect(normaliserParams({ style: "complet" }, { cle: "niveauReunion", valeur: "CHIEF_OF_STAFF" })).toEqual({ cle: "niveauReunion", valeur: "CHIEF_OF_STAFF" });
  });
  it("les canaux (§37) : « canal: Slack » devient canalPrefere slack ; une destination reste ; « 22h-7h » devient { de: 22, a: 7 }", async () => {
    const { normaliserParams } = await import("@/platform/ia/teach/store");
    expect(normaliserParams({ canal: "Slack" }, null)).toEqual({ cle: "canalPrefere", valeur: "slack" });
    expect(normaliserParams({ cle: "canal_prefere", valeur: "slack:#direction" }, null)).toEqual({ cle: "canalPrefere", valeur: "slack:#direction" });
    expect(normaliserParams({ cle: "canalPrefere", valeur: "E-mail" }, null)).toEqual({ cle: "canalPrefere", valeur: "email" });
    expect(normaliserParams({ heuresSilence: "22h-7h" }, null)).toEqual({ cle: "heuresSilence", valeur: { de: 22, a: 7 } });
    expect(normaliserParams({ cle: "silence", valeur: { de: 21, a: 8 } }, null)).toEqual({ cle: "heuresSilence", valeur: { de: 21, a: 8 } });
    expect(normaliserParams({ cle: "quiet_hours", valeur: "de 23 h à 6 h" }, null)).toEqual({ cle: "heuresSilence", valeur: { de: 23, a: 6 } });
  });
});
