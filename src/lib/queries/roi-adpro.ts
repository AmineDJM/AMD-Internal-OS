import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { chargerLiensAdPro } from "@/modules/ad-pro/api";
import { CHEMIN_DEMANDE, LIBELLE_NATURE_DEMANDE, demandeAbandonnee, type RoleMedecin, type TypeMedecinsConcernes } from "@/modules/ad-pro/partage";
import { cleNom } from "@/lib/influence/relations";
import {
  EFFET_EN_ATTENTE, ajouterMois, avantApres, choisirComparables, coutParPassage, graineDe, lettreA, lettreDeFige, mesurerEffet,
  mouvementLettre, passeEnA, sommeEntre, variationPct,
  type Effet, type FenetreMois, type NiveauAppariement, type Point, type Profil,
} from "@/lib/roi-adpro/mesure";

/**
 * LE ROI AD & PRO — la lecture (console d'administration, Super Admin seul). Tire les données de toute la plateforme :
 * médecins concernés des demandes (liens, invités et prises en charge des congrès, inscrits des événements rapprochés de
 * l'annuaire), coûts des postes validés et leur répartition par produit, affinité déclarée (Q2/Q1 historisées), lettres
 * figées à chaque cycle de Segmentation, visites et messages portés (l'effort terrain, à isoler), consommation des
 * établissements (fichiers PCH des DR). La mesure est pure : `src/lib/roi-adpro/mesure.ts`.
 */

const NATURES_ROI = ["CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "SPONSORING", "PROMO_MATERIAL", "AD_PRO_OTHER"] as const satisfies readonly TypeMedecinsConcernes[];
const PRIORITE_STATUT: Record<string, number> = { DECIDEUR: 4, INFLUENCEUR: 3, REFERENT: 2, PRESCRIPTEUR: 1 };
const MAX_COMPARABLES = 400;

export interface EffetLettres {
  hausses: number;
  mesurables: number;
  passagesA: number;
  /** Le passage le plus fréquent chez les touchés, « 2 B → A ». */
  resume: string | null;
  comparablesHausses: number;
  comparablesMesurables: number;
}

export interface ActionRoi {
  cle: string;
  nature: TypeMedecinsConcernes;
  natureLibelle: string;
  nom: string;
  date: Date;
  href: string;
  cout: number | null;
  produits: { id: string; nom: string }[];
  medecins: { doctorId: string; role: RoleMedecin }[];
  parLettre: Record<string, number>;
  disponibleLe: Date;
  enAttente: boolean;
  appariement: NiveauAppariement;
  affinite: Effet;
  lettres: EffetLettres | null;
  consommation: Effet | null;
  visites: Effet;
}

export interface NatureRoi {
  nature: TypeMedecinsConcernes;
  libelle: string;
  depense: number;
  actions: number;
  medecinsTouches: number;
  affinite: Effet;
  passagesA: number;
  coutParPassageA: number | null;
}

export interface MedecinTouche { doctorId: string; nom: string; actions: number; lettre: string | null }

export interface DetailMedecinRoi {
  doctorId: string;
  nom: string;
  etablissement: string | null;
  lettreIlYA12Mois: string | null;
  lettreActuelle: string | null;
  recu: { cle: string; nom: string; natureLibelle: string; date: Date; role: RoleMedecin; href: string }[];
  affinite: { date: Date; valeur: number; produit: string | null }[];
  visites6m: number;
  messages6m: number;
  visites6mAvant: number;
}

export interface VueRoi {
  fenetre: FenetreMois;
  produits: { id: string; nom: string }[];
  actions: ActionRoi[];
  natures: NatureRoi[];
  touches: MedecinTouche[];
  medecin: DetailMedecinRoi | null;
}

interface Demande { nature: TypeMedecinsConcernes; id: string; nom: string; date: Date; href: string; montantAccorde: number | null }

async function lireDemandes(depuis: Date): Promise<Map<string, Demande>> {
  const large = { createdAt: { gte: ajouterMois(depuis, -6) } };
  const [spo, ev, cn, ci] = await Promise.all([
    prisma.sponsoringRequest.findMany({ where: { requestDate: { gte: depuis } }, select: { id: true, institution: true, type: true, requestDate: true, status: true, amountGranted: true } }),
    prisma.event.findMany({ where: large, select: { id: true, name: true, startDate: true, createdAt: true, status: true } }),
    prisma.congressNational.findMany({ where: large, select: { id: true, name: true, date: true, createdAt: true, status: true } }),
    prisma.congressInternational.findMany({ where: large, select: { id: true, name: true, startDate: true, createdAt: true, status: true } }),
  ]);
  const out = new Map<string, Demande>();
  const put = (nature: TypeMedecinsConcernes, id: string, nom: string, date: Date, statut: string, montantAccorde: number | null) => {
    if (demandeAbandonnee(statut) || date < depuis) return;
    out.set(`${nature}:${id}`, { nature, id, nom, date, href: `${CHEMIN_DEMANDE[nature]}/${id}`, montantAccorde });
  };
  for (const s of spo) put("SPONSORING", s.id, `Sponsoring ${s.type} — ${s.institution}`, s.requestDate, String(s.status), s.amountGranted === null ? null : toNumber(s.amountGranted));
  for (const e of ev) put("EVENT", e.id, e.name, e.startDate ?? e.createdAt, String(e.status), null);
  for (const c of cn) put("CONGRESS_NATIONAL", c.id, `Congrès ${c.name}`, c.date ?? c.createdAt, String(c.status), null);
  for (const c of ci) put("CONGRESS_INTERNATIONAL", c.id, `Congrès ${c.name}`, c.startDate ?? c.createdAt, String(c.status), null);
  return out;
}

const PARENT: Record<string, TypeMedecinsConcernes> = {
  sponsoringId: "SPONSORING", eventId: "EVENT", congressNationalId: "CONGRESS_NATIONAL", congressInternationalId: "CONGRESS_INTERNATIONAL",
};

export async function vueRoi(opts: { fenetre: FenetreMois; productId?: string | null; nature?: string | null; medecinId?: string | null; maintenant?: Date }): Promise<VueRoi> {
  const maintenant = opts.maintenant ?? new Date();
  const w = opts.fenetre;
  const depuis = ajouterMois(maintenant, -24);
  const debutDonnees = ajouterMois(depuis, -12);

  // ── Les médecins de l'annuaire ──
  const [docs, fiches, cycles] = await Promise.all([
    prisma.medicalDoctor.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, lastName: true, firstName: true, specialty: true, specialtyId: true, wilaya: true, region: true, institutionId: true, institutionRef: { select: { name: true } } },
    }),
    prisma.segmentationFiche.findMany({ where: { retireeLe: null, statut: { not: null } }, select: { doctorId: true, statut: true } }),
    prisma.segmentationCycle.findMany({ select: { debut: true, instantane: true }, orderBy: { debut: "asc" } }),
  ]);
  const docDe = new Map(docs.map((d) => [d.id, d]));
  const statutDe = new Map<string, string>();
  for (const f of fiches) {
    const avant = statutDe.get(f.doctorId);
    if (f.statut && (!avant || (PRIORITE_STATUT[f.statut] ?? 0) > (PRIORITE_STATUT[avant] ?? 0))) statutDe.set(f.doctorId, f.statut);
  }
  const histo = new Map<string, { debut: Date; lettre: string }[]>();
  for (const c of cycles) {
    const pr = (c.instantane as { praticiens?: unknown } | null)?.praticiens;
    if (!Array.isArray(pr)) continue;
    for (const p of pr) {
      const id = p && typeof p === "object" ? (p as { doctorId?: unknown }).doctorId : null;
      const l = p && typeof p === "object" ? lettreDeFige(p as { h?: unknown; affichage?: unknown }) : null;
      if (typeof id === "string" && l) histo.set(id, [...(histo.get(id) ?? []), { debut: c.debut, lettre: l }]);
    }
  }
  const lettreDe = (id: string, date: Date, apresStrict?: Date) => lettreA(histo.get(id) ?? [], date, apresStrict);

  // ── L'exposition : demandes Ad & Pro et leurs médecins ──
  const [liensBruts, invN, invI, prises] = await Promise.all([
    prisma.adProMedecin.findMany({ select: { doctorId: true } }),
    prisma.congressNational.findMany({ where: { createdAt: { gte: ajouterMois(depuis, -6) } }, select: { invitedDoctorIds: true } }),
    prisma.congressInternational.findMany({ where: { createdAt: { gte: ajouterMois(depuis, -6) } }, select: { invitedDoctorIds: true } }),
    prisma.careBeneficiary.findMany({ where: { doctorId: { not: null } }, select: { doctorId: true } }),
  ]);
  const exposesIds = [...new Set([...liensBruts.map((l) => l.doctorId), ...invN.flatMap((c) => c.invitedDoctorIds), ...invI.flatMap((c) => c.invitedDoctorIds), ...prises.map((p) => p.doctorId!)])]
    .filter((id) => docDe.has(id));
  const [liens, demandes] = await Promise.all([chargerLiensAdPro(exposesIds, depuis), lireDemandes(depuis)]);

  // Les inscrits des événements, rapprochés de l'annuaire par le nom (une seule fiche : sinon on ne devine pas).
  const parCle = new Map<string, string[]>();
  for (const d of docs) for (const k of new Set([cleNom(d.lastName, d.firstName), cleNom(d.name)].filter(Boolean))) parCle.set(k, [...new Set([...(parCle.get(k) ?? []), d.id])]);
  const eventsIds = [...demandes.values()].filter((d) => d.nature === "EVENT").map((d) => d.id);
  const inscrits = eventsIds.length ? await prisma.eventRegistration.findMany({
    where: { eventId: { in: eventsIds }, status: { notIn: ["REJECTED", "CANCELLED", "ABSENT"] }, role: { in: ["DOCTOR", "PROFESSOR", "HEAD_OF_SERVICE", "PHARMACIST"] } },
    select: { eventId: true, firstName: true, lastName: true },
  }) : [];

  const actions = new Map<string, { d: Demande; medecins: Map<string, RoleMedecin>; investi: number }>();
  const action = (d: Demande) => actions.get(`${d.nature}:${d.id}`) ?? actions.set(`${d.nature}:${d.id}`, { d, medecins: new Map(), investi: 0 }).get(`${d.nature}:${d.id}`)!;
  for (const d of demandes.values()) action(d);
  for (const l of liens) {
    if (!(NATURES_ROI as readonly string[]).includes(l.nature)) continue;
    const d = demandes.get(`${l.nature}:${l.entityId}`) ?? { nature: l.nature, id: l.entityId, nom: l.nom, date: l.date, href: l.href, montantAccorde: null };
    const a = action(d);
    if (!a.medecins.has(l.doctorId) || l.role === "ORATEUR") a.medecins.set(l.doctorId, l.role);
    a.investi += l.investi ?? 0;
  }
  for (const r of inscrits) {
    const ids = parCle.get(cleNom(r.lastName, r.firstName)) ?? [];
    const d = demandes.get(`EVENT:${r.eventId}`);
    if (ids.length !== 1 || !d) continue;
    const a = action(d);
    if (!a.medecins.has(ids[0])) a.medecins.set(ids[0], "INVITE");
  }

  // ── Les coûts : postes validés, et leur répartition par produit ──
  const parents = { sponsoringId: [] as string[], eventId: [] as string[], congressNationalId: [] as string[], congressInternationalId: [] as string[] };
  for (const a of actions.values()) {
    const k = Object.entries(PARENT).find(([, n]) => n === a.d.nature)?.[0] as keyof typeof parents | undefined;
    if (k) parents[k].push(a.d.id);
  }
  const ouParent = Object.entries(parents).filter(([, ids]) => ids.length).map(([k, ids]) => ({ [k]: { in: ids } }));
  const postes = ouParent.length === 0 ? [] : await prisma.adProItem.findMany({
    where: { status: "APPROVED", OR: ouParent },
    select: {
      sponsoringId: true, eventId: true, congressNationalId: true, congressInternationalId: true, amountGranted: true, amountEstimated: true,
      productAllocations: { select: { productId: true, sharePct: true, amountAllocated: true, product: { select: { canonicalName: true } } } },
    },
  });
  const coutDe = new Map<string, number>();
  const coutProduit = new Map<string, Map<string, number>>();
  const nomProduit = new Map<string, string>();
  const COLONNES = ["sponsoringId", "eventId", "congressNationalId", "congressInternationalId"] as const;
  for (const p of postes) {
    const k = COLONNES.find((c) => p[c]);
    if (!k) continue;
    const cle = `${PARENT[k]}:${p[k]}`;
    const montant = toNumber(p.amountGranted ?? p.amountEstimated);
    coutDe.set(cle, (coutDe.get(cle) ?? 0) + montant);
    for (const al of p.productAllocations) {
      nomProduit.set(al.productId, al.product.canonicalName);
      const part = al.amountAllocated !== null ? toNumber(al.amountAllocated) : al.sharePct !== null ? (montant * toNumber(al.sharePct)) / 100 : 0;
      const m = coutProduit.get(cle) ?? coutProduit.set(cle, new Map()).get(cle)!;
      m.set(al.productId, (m.get(al.productId) ?? 0) + part);
    }
  }

  // ── Les mesures ──
  const toutesProduits = [...nomProduit.keys()];
  const [obs, visites, pch] = await Promise.all([
    prisma.hcpObservation.findMany({ where: { prescriptionsSur10: { not: null }, observeLe: { gte: debutDonnees } }, select: { doctorId: true, productId: true, observeLe: true, prescriptionsSur10: true } }),
    prisma.medicalVisit.findMany({ where: { status: "COMPLETED", doctorId: { not: null }, date: { gte: debutDonnees } }, select: { doctorId: true, date: true, _count: { select: { messageLinks: true } } } }),
    toutesProduits.length || opts.productId
      ? prisma.pchVenteLigne.groupBy({ by: ["institutionId", "productId", "mois"], where: { institutionId: { not: null }, productId: { in: [...new Set([...toutesProduits, ...(opts.productId ? [opts.productId] : [])])] }, mois: { gte: debutDonnees } }, _sum: { qteLivree: true } })
      : Promise.resolve([] as { institutionId: string | null; productId: string | null; mois: Date; _sum: { qteLivree: number | null } }[]),
  ]);
  const obsDe = new Map<string, { date: Date; valeur: number; productId: string | null }[]>();
  for (const o of obs) obsDe.set(o.doctorId, [...(obsDe.get(o.doctorId) ?? []), { date: o.observeLe, valeur: toNumber(o.prescriptionsSur10) * 10, productId: o.productId }]);
  const visitesDe = new Map<string, { date: Date; messages: number }[]>();
  for (const v of visites) visitesDe.set(v.doctorId!, [...(visitesDe.get(v.doctorId!) ?? []), { date: v.date, messages: v._count.messageLinks }]);
  const pchDe = new Map<string, Point[]>();
  for (const r of pch) {
    const k = `${r.institutionId}|${r.productId}`;
    pchDe.set(k, [...(pchDe.get(k) ?? []), { date: r.mois, valeur: r._sum.qteLivree ?? 0 }]);
  }

  // Quand chaque médecin a-t-il été touché ? (pour exclure des comparables les touchés autour de la date)
  const touchesLe = new Map<string, Date[]>();
  for (const a of actions.values()) for (const id of a.medecins.keys()) touchesLe.set(id, [...(touchesLe.get(id) ?? []), a.d.date]);

  const profil = (id: string, date: Date): Profil => {
    const d = docDe.get(id)!;
    return { specialite: d.specialtyId ?? (d.specialty ? cleNom(d.specialty) : null), zone: d.wilaya ?? d.region ?? null, lettre: lettreDe(id, date), statut: statutDe.get(id) ?? null };
  };
  const candidats = docs.map((d) => d.id);

  const deltaAffinite = (id: string, date: Date, produits: readonly string[]): number | null => {
    const pts = (obsDe.get(id) ?? []).filter((o) => produits.length === 0 || (o.productId !== null && produits.includes(o.productId)));
    const { avant, apres } = avantApres(pts, date, w);
    return avant === null || apres === null ? null : apres - avant;
  };
  const deltaVisites = (id: string, date: Date): number => {
    const pts = (visitesDe.get(id) ?? []).map((v) => ({ date: v.date, valeur: 1 }));
    return sommeEntre(pts, date, ajouterMois(date, w)) - sommeEntre(pts, ajouterMois(date, -w), date);
  };
  const variationConso = (institutionId: string, date: Date, produits: readonly string[]): number | null => {
    const pts = produits.flatMap((p) => pchDe.get(`${institutionId}|${p}`) ?? []);
    if (pts.length === 0) return null;
    return variationPct(sommeEntre(pts, ajouterMois(date, -w), date), sommeEntre(pts, date, ajouterMois(date, w)));
  };

  const resultats: ActionRoi[] = [];
  for (const [cle, a] of actions) {
    if (opts.nature && a.d.nature !== opts.nature) continue;
    const cp = coutProduit.get(cle);
    if (opts.productId && !cp?.has(opts.productId)) continue;
    const date = a.d.date;
    const fin = ajouterMois(date, w);
    const enAttente = fin.getTime() > maintenant.getTime();
    const produitsAction = opts.productId ? [opts.productId] : [...(cp?.keys() ?? [])];
    const coutTotal = coutDe.get(cle) ?? (a.d.montantAccorde ?? (a.investi > 0 ? a.investi : null));
    const cout = opts.productId ? (cp?.get(opts.productId) ?? null) : coutTotal;
    const medecins = [...a.medecins].filter(([id]) => docDe.has(id)).map(([doctorId, role]) => ({ doctorId, role }));
    const parLettre: Record<string, number> = {};
    for (const m of medecins) { const l = lettreDe(m.doctorId, date) ?? "—"; parLettre[l] = (parLettre[l] ?? 0) + 1; }
    const base = {
      cle, nature: a.d.nature, natureLibelle: LIBELLE_NATURE_DEMANDE[a.d.nature], nom: a.d.nom, date, href: a.d.href, cout,
      produits: produitsAction.map((id) => ({ id, nom: nomProduit.get(id) ?? "Produit" })), medecins, parLettre, disponibleLe: fin, enAttente,
    };
    if (medecins.length === 0 || enAttente) {
      resultats.push({ ...base, appariement: "AUCUN", affinite: EFFET_EN_ATTENTE, lettres: null, consommation: medecins.length && produitsAction.length ? EFFET_EN_ATTENTE : null, visites: EFFET_EN_ATTENTE });
      continue;
    }
    const ids = new Set(medecins.map((m) => m.doctorId));
    const exclus = new Set<string>(ids);
    for (const [id, dates] of touchesLe) if (dates.some((x) => Math.abs(x.getTime() - date.getTime()) <= fin.getTime() - date.getTime())) exclus.add(id);
    const choix = choisirComparables(
      medecins.map((m) => profil(m.doctorId, date)),
      candidats.filter((id) => !exclus.has(id)).map((id) => ({ id, profil: profil(id, date) })),
      exclus,
    );
    const comps = choix.ids.slice(0, MAX_COMPARABLES);
    const graine = graineDe(cle);
    const vals = (xs: readonly string[], f: (id: string) => number | null) => xs.map(f).filter((x): x is number => x !== null && Number.isFinite(x));
    const affinite = mesurerEffet(vals([...ids], (id) => deltaAffinite(id, date, produitsAction)), vals(comps, (id) => deltaAffinite(id, date, produitsAction)), { graine });
    const visitesEffet = mesurerEffet(vals([...ids], (id) => deltaVisites(id, date)), vals(comps, (id) => deltaVisites(id, date)), { graine: graine + 1 });
    // La consommation se lit PAR ÉTABLISSEMENT : un établissement compte une fois, et ceux des touchés sortent des comparables.
    let consommation: Effet | null = null;
    if (produitsAction.length) {
      const etabsTouches = [...new Set([...ids].map((id) => docDe.get(id)!.institutionId).filter((x): x is string => !!x))];
      const etabsComp = [...new Set(comps.map((id) => docDe.get(id)!.institutionId).filter((x): x is string => !!x && !etabsTouches.includes(x)))];
      consommation = mesurerEffet(vals(etabsTouches, (e) => variationConso(e, date, produitsAction)), vals(etabsComp, (e) => variationConso(e, date, produitsAction)), { graine: graine + 2 });
    }
    // Les lettres : celle du cycle en cours à la date, puis celle d'un cycle ouvert APRÈS l'action, dans la fenêtre.
    const mouv = (id: string) => { const av = lettreDe(id, date); const ap = lettreDe(id, fin, date); return { av, ap, m: mouvementLettre(av, ap) }; };
    const mt = [...ids].map(mouv).filter((x) => x.m !== null);
    const mc = comps.map(mouv).filter((x) => x.m !== null);
    const passages = new Map<string, number>();
    for (const x of mt) if (x.m === "HAUSSE") passages.set(`${x.av} → ${x.ap}`, (passages.get(`${x.av} → ${x.ap}`) ?? 0) + 1);
    const top = [...passages].sort((p, q) => q[1] - p[1])[0];
    const lettres: EffetLettres = {
      hausses: mt.filter((x) => x.m === "HAUSSE").length, mesurables: mt.length, passagesA: mt.filter((x) => passeEnA(x.av, x.ap)).length,
      resume: top ? `${top[1]} ${top[0]}` : null,
      comparablesHausses: mc.filter((x) => x.m === "HAUSSE").length, comparablesMesurables: mc.length,
    };
    resultats.push({ ...base, appariement: choix.niveau, affinite, lettres, consommation, visites: visitesEffet });
  }
  resultats.sort((x, y) => y.date.getTime() - x.date.getTime());

  // ── Par nature, sur 12 mois ──
  const il12 = ajouterMois(maintenant, -12);
  const natures: NatureRoi[] = [];
  for (const n of NATURES_ROI) {
    const liste = resultats.filter((r) => r.nature === n && r.date >= il12);
    if (liste.length === 0) continue;
    const mesurees = liste.filter((r) => r.affinite.statut !== "EN_ATTENTE");
    // L'effet poolé : toutes les variations des touchés face à toutes celles des comparables, une seule fourchette.
    const exp: number[] = [], cmp: number[] = [];
    for (const r of mesurees) {
      if (r.affinite.moyenneExposes !== null) exp.push(...Array(r.affinite.nExposes).fill(r.affinite.moyenneExposes));
      if (r.affinite.moyenneComparables !== null) cmp.push(...Array(r.affinite.nComparables).fill(r.affinite.moyenneComparables));
    }
    const passagesA = liste.reduce((s, r) => s + (r.lettres?.passagesA ?? 0), 0);
    const depenseMesuree = mesurees.reduce((s, r) => s + (r.cout ?? 0), 0);
    natures.push({
      nature: n, libelle: LIBELLE_NATURE_DEMANDE[n], depense: liste.reduce((s, r) => s + (r.cout ?? 0), 0), actions: liste.length,
      medecinsTouches: new Set(liste.flatMap((r) => r.medecins.map((m) => m.doctorId))).size,
      affinite: mesurees.length ? mesurerEffet(exp, cmp, { graine: graineDe(n) }) : EFFET_EN_ATTENTE,
      passagesA, coutParPassageA: coutParPassage(depenseMesuree, passagesA),
    });
  }

  // ── Les médecins les plus touchés ──
  const compte = new Map<string, number>();
  for (const r of resultats) for (const m of r.medecins) compte.set(m.doctorId, (compte.get(m.doctorId) ?? 0) + 1);
  const touches = [...compte].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id, n]) => ({ doctorId: id, nom: docDe.get(id)?.name ?? id, actions: n, lettre: lettreDe(id, maintenant) }));

  // ── Un médecin : ce qu'il a reçu, ce qui a bougé ──
  let medecin: DetailMedecinRoi | null = null;
  const md = opts.medecinId ? docDe.get(opts.medecinId) : undefined;
  if (md) {
    const recu = resultats.filter((r) => r.medecins.some((m) => m.doctorId === md.id)).map((r) => ({
      cle: r.cle, nom: r.nom, natureLibelle: r.natureLibelle, date: r.date, href: r.href, role: r.medecins.find((m) => m.doctorId === md.id)!.role,
    }));
    const v = visitesDe.get(md.id) ?? [];
    const il6 = ajouterMois(maintenant, -6), il12b = ajouterMois(maintenant, -12);
    medecin = {
      doctorId: md.id, nom: md.name, etablissement: md.institutionRef?.name ?? null,
      lettreIlYA12Mois: lettreDe(md.id, il12b), lettreActuelle: lettreDe(md.id, maintenant), recu,
      affinite: (obsDe.get(md.id) ?? []).sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 6)
        .map((o) => ({ date: o.date, valeur: o.valeur, produit: o.productId ? (nomProduit.get(o.productId) ?? null) : null })),
      visites6m: v.filter((x) => x.date >= il6).length,
      messages6m: v.filter((x) => x.date >= il6).reduce((s, x) => s + x.messages, 0),
      visites6mAvant: v.filter((x) => x.date >= il12b && x.date < il6).length,
    };
  }

  const produits = [...nomProduit].map(([id, nom]) => ({ id, nom })).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  return { fenetre: w, produits, actions: resultats, natures, touches, medecin };
}
