import { prisma } from "@/lib/prisma";
import { lettresDesPraticiens } from "@/lib/segmentation/lettres-service";
import { choisirEntree } from "@/lib/segmentation/lettre-requise";
import { CLE_EXECUTION, chargerContexteInfluence, type BilanAnalyse } from "@/lib/influence-luna";
import { chefsDuService, libelleCourt, type TypeRelation } from "@/lib/influence/relations";
import { ordreDEntree, suggererInfluenceur, type EtapeEntree, type Raison } from "@/lib/influence/score";
import { partsDeNosLotsEtablissement, type VuePartsLots } from "@/lib/queries/parts-lots";
import { sansBloquer } from "@/lib/journal";

/**
 * LE GRAPHE D'INFLUENCE — la lecture de la console (Super Admin seul). Les scores et les liens sont ceux que l'analyse a
 * rangés (`influence-luna.ts`) ; la lettre est celle de la Segmentation (`lettresDesPraticiens`, la même partout).
 */

export interface NoeudGraphe {
  doctorId: string;
  nom: string;
  court: string;
  lettre: string | null;
  statut: string | null;
  score: number;
  chef: boolean;
  pharmacien: boolean;
  /** Hors du service (relié par un lien) — son établissement. */
  externe: string | null;
}

export interface AreteGraphe { from: string; to: string; type: TypeRelation; statut: string; source: string }

export interface ServiceGraphe {
  serviceId: string;
  nom: string;
  noeuds: NoeudGraphe[];
  aretes: AreteGraphe[];
  masques: number;
  ordre: (EtapeEntree & { lettre: string | null })[];
  besoin: { annee: number; quantite: number } | null;
}

export interface LigneInfluenceur {
  doctorId: string;
  nom: string;
  etablissement: string | null;
  statut: string | null;
  lettre: string | null;
  score: number;
  raisons: string[];
  suggestion: boolean;
  lienSegmentation: string | null;
}

export interface LienPropose {
  id: string;
  de: { id: string; nom: string };
  vers: { id: string; nom: string };
  type: TypeRelation;
  confiance: number;
  rapprochement: string | null;
  citation: string | null;
  rapportHref: string | null;
  rapportLibelle: string;
}

export interface DetailReseau {
  doctorId: string;
  nom: string;
  etablissement: string | null;
  service: string | null;
  statut: string | null;
  lettre: string | null;
  score: number;
  raisons: Raison[];
  liens: { autre: { id: string; nom: string }; sens: "SORTANT" | "ENTRANT"; type: TypeRelation; source: string; statut: string }[];
}

export interface VueInfluence {
  analyse: { le: Date | null; bilan: BilanAnalyse | null };
  etablissements: { id: string; nom: string; n: number }[];
  services: { id: string; nom: string }[];
  produits: { id: string; nom: string }[];
  etabId: string | null;
  serviceId: string | null;
  produit: { id: string; nom: string } | null;
  graphes: ServiceGraphe[];
  top: LigneInfluenceur[];
  file: LienPropose[];
  detail: DetailReseau | null;
  /** La part de nos lots livrés à l'établissement montré — `null` si la lecture a échoué ou qu'aucun établissement n'est choisi. */
  partsLots: VuePartsLots | null;
}

const MAX_NOEUDS = 14;
const MAX_EXTERNES = 4;

const lireRaisons = (v: unknown): Raison[] => (Array.isArray(v) ? (v as Raison[]).filter((r) => r && typeof r.libelle === "string" && typeof r.points === "number") : []);

export async function vueInfluence(opts: { etabId?: string | null; serviceId?: string | null; productId?: string | null; medecinId?: string | null }): Promise<VueInfluence> {
  const [execution, ctx, scores, etabsG, produits, propositions] = await Promise.all([
    prisma.analyseWatermark.findUnique({ where: { cle: CLE_EXECUTION }, select: { derniereExecution: true, bilan: true } }),
    chargerContexteInfluence(),
    prisma.influenceScore.findMany({ orderBy: { score: "desc" }, select: { doctorId: true, score: true, raisons: true } }),
    prisma.medicalDoctor.groupBy({ by: ["institutionId"], where: { archivedAt: null, institutionId: { not: null } }, _count: { _all: true } }),
    prisma.product.findMany({ where: { promoProfiles: { some: {} } }, orderBy: { canonicalName: "asc" }, select: { id: true, canonicalName: true } }),
    prisma.praticienRelation.findMany({
      where: { statut: "PROPOSEE", source: "LUNA" }, orderBy: [{ confidence: "desc" }, { createdAt: "desc" }], take: 50,
      select: { id: true, fromDoctorId: true, toDoctorId: true, type: true, confidence: true, rapprochement: true, evidence: true, reportId: true },
    }),
  ]);
  const scoreDe = new Map(scores.map((s) => [s.doctorId, s]));
  const medDe = new Map(ctx.medecins.map((m) => [m.id, m]));
  const insts = await prisma.medicalInstitution.findMany({ where: { id: { in: etabsG.map((e) => e.institutionId!) } }, select: { id: true, name: true } });
  const nomEtab = new Map(insts.map((i) => [i.id, i.name]));
  const etablissements = etabsG.map((e) => ({ id: e.institutionId!, nom: nomEtab.get(e.institutionId!) ?? "—", n: e._count._all })).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));

  // L'établissement montré : celui demandé, sinon celui du praticien le plus influent rattaché à un service.
  const parDefaut = scores.map((s) => medDe.get(s.doctorId)).find((m) => m?.institutionId && ctx.serviceDe.get(m.id))?.institutionId ?? null;
  const etabId = opts.etabId && nomEtab.has(opts.etabId) ? opts.etabId : parDefaut;
  const services = etabId ? (await prisma.medicalInstitutionService.findMany({ where: { institutionId: etabId }, orderBy: { name: "asc" }, select: { id: true, name: true } })).map((s) => ({ id: s.id, nom: s.name })) : [];
  const serviceId = opts.serviceId && services.some((s) => s.id === opts.serviceId) ? opts.serviceId : null;
  const produitRow = opts.productId ? produits.find((p) => p.id === opts.productId) : undefined;
  const produit = produitRow ? { id: produitRow.id, nom: produitRow.canonicalName } : null;

  // Les services à dessiner : celui choisi, sinon les plus peuplés (4 au plus).
  const membresDe = new Map<string, string[]>();
  for (const m of ctx.membres) if (m.serviceId) membresDe.set(m.serviceId, [...(membresDe.get(m.serviceId) ?? []), m.doctorId]);
  const aDessiner = (serviceId ? services.filter((s) => s.id === serviceId) : services.filter((s) => (membresDe.get(s.id)?.length ?? 0) >= 2)
    .sort((a, b) => (membresDe.get(b.id)?.length ?? 0) - (membresDe.get(a.id)?.length ?? 0)).slice(0, 4));

  const idsServices = aDessiner.flatMap((s) => membresDe.get(s.id) ?? []);
  const relations = idsServices.length ? await prisma.praticienRelation.findMany({
    where: { statut: { not: "REJETEE" }, OR: [{ fromDoctorId: { in: idsServices } }, { toDoctorId: { in: idsServices } }] },
    select: { fromDoctorId: true, toDoctorId: true, type: true, statut: true, source: true },
  }) : [];

  const top = scores.slice(0, 30);
  const detailId = opts.medecinId && medDe.has(opts.medecinId) ? opts.medecinId : null;
  const idsLettres = [...new Set([...idsServices, ...relations.flatMap((r) => [r.fromDoctorId, r.toDoctorId]), ...top.map((t) => t.doctorId), ...(detailId ? [detailId] : [])])];
  const [entrees, fiches, besoins] = await Promise.all([
    lettresDesPraticiens(idsLettres).catch(sansBloquer("influence.vueInfluence.lettresDesPraticiens", new Map())),
    prisma.segmentationFiche.findMany({ where: { doctorId: { in: top.map((t) => t.doctorId) }, retireeLe: null }, orderBy: { createdAt: "asc" }, select: { doctorId: true, strategieId: true } }),
    produit && etabId ? prisma.besoinAnnuelService.findMany({ where: { productId: produit.id, institutionId: etabId }, orderBy: { annee: "desc" }, select: { serviceId: true, annee: true, quantite: true } }) : Promise.resolve([]),
  ]);
  const lettreDe = (id: string) => choisirEntree(entrees.get(id), null)?.lettre ?? null;
  const pharmacien = new Map(ctx.membres.map((m) => [m.doctorId, m.pharmacien]));

  const graphes: ServiceGraphe[] = aDessiner.map((s) => {
    const membres = ctx.membres.filter((m) => m.serviceId === s.id);
    const chefs = new Set(chefsDuService(membres));
    const tries = [...membres].sort((a, b) => Number(chefs.has(b.doctorId)) - Number(chefs.has(a.doctorId)) || (scoreDe.get(b.doctorId)?.score ?? 0) - (scoreDe.get(a.doctorId)?.score ?? 0));
    const montres = tries.slice(0, MAX_NOEUDS);
    const dedans = new Set(montres.map((m) => m.doctorId));
    const noeud = (id: string, externe: string | null): NoeudGraphe => {
      const m = medDe.get(id)!;
      return {
        doctorId: id, nom: m.name, court: libelleCourt(m.name, m.title), lettre: lettreDe(id), statut: ctx.statutDe.get(id) ?? null,
        score: scoreDe.get(id)?.score ?? 0, chef: chefs.has(id), pharmacien: pharmacien.get(id) ?? false, externe,
      };
    };
    const noeuds = montres.map((m) => noeud(m.doctorId, null));
    const tousMembres = new Set(membres.map((m) => m.doctorId));
    const externes: string[] = [];
    for (const r of relations) {
      const [a, b] = [r.fromDoctorId, r.toDoctorId];
      const autre = dedans.has(a) && !tousMembres.has(b) ? b : dedans.has(b) && !tousMembres.has(a) ? a : null;
      if (autre && medDe.has(autre) && !externes.includes(autre) && externes.length < MAX_EXTERNES) externes.push(autre);
    }
    for (const e of externes) noeuds.push(noeud(e, nomEtab.get(medDe.get(e)!.institutionId ?? "") ?? medDe.get(e)!.institutionId ?? "autre établissement"));
    const visibles = new Set(noeuds.map((n) => n.doctorId));
    const aretes = relations.filter((r) => visibles.has(r.fromDoctorId) && visibles.has(r.toDoctorId))
      .map((r) => ({ from: r.fromDoctorId, to: r.toDoctorId, type: r.type as TypeRelation, statut: r.statut, source: r.source }));
    const influences = (id: string) => new Set(relations.filter((r) => r.fromDoctorId === id && r.source !== "STRUCTURE" && tousMembres.has(r.toDoctorId)).map((r) => r.toDoctorId)).size;
    const ordre = ordreDEntree(membres.map((m) => ({
      doctorId: m.doctorId, nom: medDe.get(m.doctorId)!.name, grade: m.grade, statut: m.statut, decideurBesoin: m.decideurBesoin,
      pharmacien: m.pharmacien, score: scoreDe.get(m.doctorId)?.score ?? 0, influences: influences(m.doctorId),
    }))).map((o) => ({ ...o, lettre: lettreDe(o.doctorId) }));
    const b = besoins.find((x) => x.serviceId === s.id);
    return { serviceId: s.id, nom: s.nom, noeuds, aretes, masques: Math.max(0, membres.length - montres.length), ordre, besoin: b ? { annee: b.annee, quantite: b.quantite } : null };
  });

  const strategieDe = new Map<string, string>();
  for (const f of fiches) if (!strategieDe.has(f.doctorId)) strategieDe.set(f.doctorId, f.strategieId);
  const lignesTop: LigneInfluenceur[] = top.filter((t) => medDe.has(t.doctorId)).map((t) => {
    const m = medDe.get(t.doctorId)!;
    const raisons = lireRaisons(t.raisons);
    const statut = ctx.statutDe.get(t.doctorId) ?? null;
    const s = strategieDe.get(t.doctorId);
    return {
      doctorId: t.doctorId, nom: m.name, etablissement: m.institutionId ? (nomEtab.get(m.institutionId) ?? null) : null, statut, lettre: lettreDe(t.doctorId),
      score: t.score, raisons: raisons.sort((a, b) => b.points - a.points).slice(0, 2).map((r) => r.libelle),
      suggestion: suggererInfluenceur(statut, { score: t.score, raisons }),
      lienSegmentation: s ? `/segmentation?s=${encodeURIComponent(s)}&vue=praticiens&q=${encodeURIComponent(m.name)}` : null,
    };
  });

  const nom = (id: string) => medDe.get(id)?.name ?? "Praticien retiré";
  const file: LienPropose[] = propositions.map((p) => ({
    id: p.id, de: { id: p.fromDoctorId, nom: nom(p.fromDoctorId) }, vers: { id: p.toDoctorId, nom: nom(p.toDoctorId) }, type: p.type as TypeRelation,
    confiance: p.confidence, rapprochement: p.rapprochement, citation: p.evidence,
    rapportHref: p.reportId && !p.reportId.startsWith("visite:") ? `/medical/rapports/${p.reportId}` : null,
    rapportLibelle: p.reportId?.startsWith("visite:") ? "compte rendu de visite" : "rapport",
  }));

  let detail: DetailReseau | null = null;
  if (detailId) {
    const m = medDe.get(detailId)!;
    const [liens, service] = await Promise.all([
      prisma.praticienRelation.findMany({
        where: { statut: { not: "REJETEE" }, OR: [{ fromDoctorId: detailId }, { toDoctorId: detailId }] },
        orderBy: { createdAt: "desc" }, take: 40, select: { fromDoctorId: true, toDoctorId: true, type: true, source: true, statut: true },
      }),
      ctx.serviceDe.get(detailId) ? prisma.medicalInstitutionService.findUnique({ where: { id: ctx.serviceDe.get(detailId)! }, select: { name: true } }) : Promise.resolve(null),
    ]);
    const sc = scoreDe.get(detailId);
    detail = {
      doctorId: detailId, nom: m.name, etablissement: m.institutionId ? (nomEtab.get(m.institutionId) ?? null) : null, service: service?.name ?? null,
      statut: ctx.statutDe.get(detailId) ?? null, lettre: lettreDe(detailId), score: sc?.score ?? 0, raisons: lireRaisons(sc?.raisons),
      liens: liens.map((l) => {
        const sortant = l.fromDoctorId === detailId;
        const autre = sortant ? l.toDoctorId : l.fromDoctorId;
        return { autre: { id: autre, nom: nom(autre) }, sens: sortant ? "SORTANT" as const : "ENTRANT" as const, type: l.type as TypeRelation, source: l.source, statut: l.statut };
      }),
    };
  }

  // LA PART DE NOS LOTS de l'établissement montré (niveau le plus fin des fichiers de la PCH : pas de volume par service).
  const partsLots = etabId ? await partsDeNosLotsEtablissement(etabId, produit?.id ?? null).catch(sansBloquer("influence.vueInfluence.partsDeNosLotsEtablissement", null)) : null;

  return {
    analyse: { le: execution?.derniereExecution ?? null, bilan: (execution?.bilan as unknown as BilanAnalyse | null) ?? null },
    etablissements, services, produits: produits.map((p) => ({ id: p.id, nom: p.canonicalName })),
    etabId, serviceId, produit, graphes, top: lignesTop, file, detail, partsLots,
  };
}
