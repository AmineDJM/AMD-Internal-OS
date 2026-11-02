import Link from "next/link";
import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { DOCTOR_TITLE } from "@/lib/labels";
import { PageHeader } from "@/components/shared/page-header";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { chargerStrategie, chargerPanel, chargerSecteurs, type LignePanel, type SecteurBu } from "@/lib/segmentation/service";
import { droitsSegmentation, porteeSegmentation } from "@/lib/segmentation/droits";
import { grilleDuSecteur, type Lettre, type RegleProduit, type Regles } from "@/lib/segmentation/regles";
import { PROPOSITION, contactsDe, matriceDe } from "@/lib/segmentation/charge";
import { CreerStrategie } from "./creer-strategie";
import { EditeurRegles } from "./regles-editeur";
import { ClassementProduits } from "./classement-produits";
import { SpecialitesProduits } from "./specialites-produits";
import { CyclesVue } from "./cycles-vue";
import { SyntheseVue, type CarteSecteur, type Tuiles } from "./synthese-vue";
import { PraticiensTable, type LignePraticien, type RegleEcran } from "./praticiens-table";
import { ReglesVue } from "./regles-vue";
import { chargerCycle } from "@/lib/segmentation/cycle-service";
import { lireEtat, casseNom, nomCourtProduit } from "@/lib/segmentation/tableau-praticiens";
import { peutAnnuaire } from "@/lib/rbac";
import { InfoBulle } from "@/components/ui/info-bulle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Segmentation — AMD Internal OS" };

/** Les trois vues de la page ; les autres (cycles, historique, import, règles détaillées) passent par « ⋯ ». */
const ONGLETS = [
  { cle: "synthese", label: "Synthèse" },
  { cle: "praticiens", label: "Praticiens" },
  { cle: "regles", label: "Règles" },
] as const;
const VUES = ["synthese", "praticiens", "regles", "cycles", "historique", "avance"] as const;
const IMPORT = "/segmentation/import";
type Vue = (typeof VUES)[number];

const norme = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** L'exception d'affinité d'un secteur — par identifiant, ou par nom pour les règles d'avant les secteurs. */
function exceptionDuSecteur(p: RegleProduit | undefined, s: { id: string; nom: string }) {
  return p?.exceptions.find((e) => e.seuilAffinite !== undefined && (e.secteurId ? e.secteurId === s.id : norme(e.zone) === norme(s.nom)));
}

/**
 * SEGMENTATION — la segmentation de la force de vente, par BU (Direction, 07/10 — maquette validée).
 *
 * Une stratégie par BU, ses produits classés, des règles VERSIONNÉES. Les praticiens sont ceux de l'annuaire ; leur
 * lettre (H, A, B, C, D, NA, non ciblé) se CALCULE depuis Q1, Q2, le statut et les règles, secteur par secteur de la
 * BU. Forcer une lettre est un droit que le Super Admin accorde personne par personne (motif obligatoire, historisé).
 */
export default async function SegmentationPage(
  props: { searchParams?: Promise<{ s?: string; vue?: string; spe?: string; cycle?: string; bu?: string } & Record<string, string | string[] | undefined>> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("SEGMENTATION");
  const droits = droitsSegmentation(user);
  const portee = porteeSegmentation(user);

  // UNE PORTE DE VÉRITÉ : les BU sont celles de la FORCE DE VENTE, chacune au plus une stratégie active.
  const bus = await prisma.businessUnit.findMany({
    where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true, name: true,
      segmentationStrategies: { where: { statut: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
      products: { where: { isActive: true, productId: { not: null } }, select: { productId: true, canonicalProduct: { select: { canonicalName: true, dci: true } } } },
    },
  });
  const catalogue = (buId: string) => {
    const b = bus.find((x) => x.id === buId);
    const vus = new Set<string>();
    return (b?.products ?? []).filter((p) => p.productId && !vus.has(p.productId) && vus.add(p.productId)).map((p) => ({ id: p.productId!, nom: p.canonicalProduct?.canonicalName ?? p.productId!, dci: p.canonicalProduct?.dci ?? "" }));
  };
  const strategieDe = (b: (typeof bus)[number]) => b.segmentationStrategies[0]?.id ?? null;
  const parStrategie = searchParams?.s ? bus.find((b) => strategieDe(b) === searchParams.s) : undefined;
  const buChoisie = parStrategie ?? bus.find((b) => b.id === searchParams?.bu) ?? bus.find((b) => strategieDe(b)) ?? bus[0] ?? null;
  const vueDemandee = searchParams?.vue === "panel" ? "praticiens" : searchParams?.vue;
  // L'import a son espace (`/segmentation/import`) : l'ancienne vue y mène.
  if (vueDemandee === "import") redirect(IMPORT);
  const vue: Vue = (VUES as readonly string[]).includes(vueDemandee ?? "") ? (vueDemandee as Vue) : "synthese";
  // « IMPORTER LE FICHIER » : en tête de page dans TOUS les états (BU sans stratégie comprise) — le Super Admin l'a toujours.
  const boutonImport = droits.valider
    ? <Link href={IMPORT} className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary sm:h-8">Importer le fichier</Link>
    : null;

  const puce = "whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-medium";
  const barreBu = (
    <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Business unit">
      {bus.filter((b) => strategieDe(b)).map((b) => (
        <Link key={b.id} href={`/segmentation?s=${strategieDe(b)}`} aria-current={b.id === buChoisie?.id ? "page" : undefined}
          className={cn(puce, b.id === buChoisie?.id ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground")}>
          BU {b.name}
        </Link>
      ))}
      {droits.valider && bus.filter((b) => !strategieDe(b)).map((b) => (
        <Link key={b.id} href={`/segmentation?bu=${b.id}`}
          className={cn(puce, "border-dashed", b.id === buChoisie?.id ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
          + BU {b.name}
        </Link>
      ))}
    </div>
  );

  if (!buChoisie) {
    return (
      <div className="space-y-4">
        <PageHeader title="Segmentation">{boutonImport}</PageHeader>
        <p className="surface rounded-xl p-5 text-sm text-muted-foreground">Aucune Business Unit active : elles se créent dans <Link href="/planning/business-units" className="text-primary underline">Force de vente › Business Units</Link>.</p>
      </div>
    );
  }
  const choisieId = strategieDe(buChoisie);
  if (!choisieId) {
    return (
      <div className="space-y-4">
        <PageHeader title="Segmentation" description={`BU ${buChoisie.name} · segmentation à activer`}>{boutonImport}</PageHeader>
        {barreBu}
        {droits.valider ? (
          <CreerStrategie bu={{ id: buChoisie.id, nom: buChoisie.name }} produits={catalogue(buChoisie.id)} />
        ) : (
          <p className="surface rounded-xl p-5 text-sm text-muted-foreground">La segmentation de cette BU n&apos;est pas encore activée.</p>
        )}
      </div>
    );
  }

  const strategie = (await chargerStrategie(choisieId))!;
  const [panelComplet, secteursBu, specialitesBu, auteur] = await Promise.all([
    chargerPanel(strategie, portee),
    chargerSecteurs(strategie.businessUnit.id),
    prisma.businessUnitSpecialty.findMany({
      where: { businessUnitId: strategie.businessUnit.id }, orderBy: [{ principale: "desc" }, { specialty: { name: "asc" } }],
      select: { specialtyId: true, principale: true, specialty: { select: { name: true } } },
    }),
    strategie.regle?.publieeParId ? prisma.user.findUnique({ where: { id: strategie.regle.publieeParId }, select: { name: true } }) : null,
  ]);
  const spe = specialitesBu.some((x) => x.specialtyId === searchParams?.spe) ? searchParams!.spe! : null;
  const panel = spe ? panelComplet.filter((l) => l.specialiteId === spe) : panelComplet;
  const regles = strategie.regle?.regles ?? null;
  const p1 = strategie.produits[0] ?? null;
  const regleP1 = regles?.produits.find((p) => p.productId === p1?.productId) ?? regles?.produits[0];
  const href = (v: string) => `/segmentation?s=${strategie.id}${v === "synthese" ? "" : `&vue=${v}`}${spe ? `&spe=${spe}` : ""}`;

  const publication = strategie.regle
    ? `règles v${strategie.regle.version} publiées le ${strategie.regle.publieeLe.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Algiers" })}${auteur?.name ? ` par ${auteur.name}` : ""}`
    : "règles à publier";
  // Le produit #1 en court ; les autres derrière « +N produits » (la liste complète dans l'ⓘ).
  const autres = strategie.produits.slice(1);
  const sousTitre = (
    <>
      {p1 ? nomCourtProduit(p1.nom) : "aucun produit classé"}
      {autres.length > 0 && (
        <span className="inline-flex items-center gap-1 align-middle">
          {" "}+{autres.length} produit{autres.length > 1 ? "s" : ""}
          <InfoBulle label="Produits classés" align="left">
            <ol className="list-decimal space-y-0.5 pl-4">{strategie.produits.map((p) => <li key={p.productId}>{p.nom}</li>)}</ol>
          </InfoBulle>
        </span>
      )}
      {` · ${publication}`}
    </>
  );

  // LE TABLEAU ÉDITABLE (Direction, 08/10) : l'identité est celle de l'ANNUAIRE — mêmes droits que sa feuille.
  const annuaire = { modifier: peutAnnuaire(user, "MEDECINS", "UPDATE"), supprimer: peutAnnuaire(user, "MEDECINS", "DELETE") };
  const [etablissementsChoix, specialitesChoix] = vue === "praticiens" && annuaire.modifier
    ? await Promise.all([
      prisma.medicalInstitution.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, wilaya: true } }),
      prisma.medicalSpecialty.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ])
    : [[], []];

  const secteursActifs = secteursBu.filter((s) => s.actif);
  const secteursChoix = secteursActifs.map((s) => ({ id: s.id, nom: s.nom }));

  return (
    <div className="space-y-4">
      <PageHeader title="Segmentation" description={sousTitre}>
        {boutonImport}
        <a href={`/api/segmentation/export?s=${strategie.id}`} className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary sm:h-8">Exporter</a>
        <MenuDossier>
          <MenuLien href={href("cycles")}>Cycles de visite</MenuLien>
          {droits.valider && <MenuLien href={href("historique")}>Historique (versions, imports, forçages)</MenuLien>}
          <MenuLien href={href("avance")}>Règles détaillées et produits classés</MenuLien>
          <MenuLien href={`/business-units/${strategie.businessUnit.id}`}>Cockpit de la BU</MenuLien>
        </MenuDossier>
      </PageHeader>
      {barreBu}

      {strategie.regle && strategie.regle.erreurs.length > 0 && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Règles v{strategie.regle.version} illisibles : {strategie.regle.erreurs.join(" ")}</p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border">
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Vues">
          {ONGLETS.map((o) => (
            <Link key={o.cle} href={href(o.cle)} aria-current={vue === o.cle ? "page" : undefined}
              className={cn("whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium", vue === o.cle ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {o.label}
            </Link>
          ))}
          {!(ONGLETS as readonly { cle: string }[]).some((o) => o.cle === vue) && (
            <span className="whitespace-nowrap border-b-2 border-primary px-3.5 py-2.5 text-sm font-medium">
              {{ cycles: "Cycles", historique: "Historique", avance: "Règles détaillées" }[vue as "cycles" | "historique" | "avance"]}
            </span>
          )}
        </nav>
        {specialitesBu.length > 1 && (
          <div className="flex flex-wrap gap-1 pb-1.5 text-xs">
            <Link href={`/segmentation?s=${strategie.id}${vue === "synthese" ? "" : `&vue=${vue}`}`} className={cn("rounded-full border px-2.5 py-1", !spe ? "border-primary text-primary" : "border-border text-muted-foreground")}>Toutes spécialités</Link>
            {specialitesBu.map((x) => (
              <Link key={x.specialtyId} href={`/segmentation?s=${strategie.id}${vue === "synthese" ? "" : `&vue=${vue}`}&spe=${x.specialtyId}`} className={cn("rounded-full border px-2.5 py-1", spe === x.specialtyId ? "border-primary text-primary" : "border-border text-muted-foreground")}>{casseNom(x.specialty.name)}</Link>
            ))}
          </div>
        )}
      </div>

      {vue === "synthese" && (regles ? <Synthese panel={panel} secteurs={secteursBu} toutesLignes={droits.toutesLignes} regles={regles} regleP1={regleP1} /> : (
        <p className="surface rounded-xl p-5 text-sm text-muted-foreground">
          Aucune règle publiée : la synthèse se calcule dès la première version (<Link href={href("regles")} className="text-primary underline">onglet Règles</Link>{droits.valider ? <>, ou <Link href={IMPORT} className="text-primary underline">importez le fichier</Link></> : null}).
        </p>
      ))}

      {vue === "praticiens" && (
        <PraticiensTable
          key={`${strategie.id}:${spe ?? ""}`}
          strategieId={strategie.id}
          produitNom={p1?.nom ?? null}
          produitCourt={p1 ? nomCourtProduit(p1.nom) : null}
          metrique={regleP1?.metrique ?? null}
          methode={regleP1?.methodeAffinite ?? "SUR_10"}
          lignes={panel.map(versLigne)}
          secteurs={secteursChoix}
          droits={{ saisir: droits.saisir, panel: droits.panel, valider: droits.valider, forcer: droits.forcer }}
          annuaire={annuaire}
          etablissements={etablissementsChoix.map((e) => ({ id: e.id, nom: e.name, wilaya: e.wilaya }))}
          specialites={specialitesChoix.map((s) => ({ id: s.id, nom: s.name }))}
          grades={Object.entries(DOCTOR_TITLE).map(([valeur, libelle]) => ({ valeur, libelle }))}
          regle={regleEcran(regles, regleP1, secteursActifs)}
          etatInitial={lireEtat(searchParams)}
        />
      )}

      {vue === "regles" && (
        <ReglesVue
          key={strategie.regle?.version ?? 0}
          strategieId={strategie.id}
          produits={strategie.produits}
          version={strategie.regle?.version ?? 0}
          contenu={regles}
          secteurs={secteursChoix}
          peutPublier={droits.valider}
        />
      )}

      {vue === "cycles" && <CyclesSection strategieId={strategie.id} cycleDemande={searchParams?.cycle} peutGerer={droits.valider} moi={droits.toutesLignes ? null : user.id} />}

      {vue === "avance" && (
        <div className="space-y-5">
          {droits.valider && (
            <SpecialitesProduits
              strategieId={strategie.id}
              produits={strategie.produits}
              specialitesBu={specialitesBu.map((x) => ({ id: x.specialtyId, nom: x.specialty.name, principale: x.principale }))}
              cibles={strategie.contexte.specialitesParProduit ?? {}}
            />
          )}
          {droits.valider && <ClassementProduits strategieId={strategie.id} actuels={strategie.produits.map((p) => p.productId)} produits={catalogue(buChoisie.id)} />}
          <EditeurRegles strategieId={strategie.id} produits={strategie.produits} version={strategie.regle?.version ?? 0} contenu={regles} peutPublier={droits.valider} />
        </div>
      )}

      {vue === "historique" && droits.valider && <Historique strategieId={strategie.id} doctorIds={panel.map((l) => l.doctorId)} />}
    </div>
  );
}

function MenuLien({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} role="menuitem" className="rounded-md px-2.5 py-2 text-sm hover:bg-secondary">{children}</Link>;
}

/** Une ligne du panel, telle que le tableau la montre. */
function versLigne(l: LignePanel): LignePraticien {
  const r = l.resultat;
  const pourquoi = r ? [
    ...(r.lettreCalculee === "H" ? ["Décideur : H d'office."] : []),
    ...(r.produits[0]?.pourquoi ?? []),
    r.pourquoiVisites,
  ] : [];
  return {
    doctorId: l.doctorId, secteurId: l.secteurId, secteurNom: l.secteurNom, secteurPose: l.secteurPose,
    institutionId: l.institutionId, etablissement: l.etablissement,
    // In / Out n'a de sens que dans un secteur (sa ville pivot) : sans secteur, rien n'est affiché.
    inOut: l.secteurId ? l.inOut : null,
    specialiteId: l.specialiteId, specialite: l.specialite,
    nomFamille: l.nomFamille, prenom: l.prenom, titre: l.grade, grade: DOCTOR_TITLE[l.grade] ?? l.grade, gradeBrut: l.gradeBrut, statut: l.statut,
    q1: l.q1, q2: l.q2,
    lettre: r?.lettre ?? null, lettreCalculee: r?.lettreCalculee ?? null, forcee: r?.lettreForcee ?? null, pourquoi,
  };
}

/** De quoi recalculer une lettre à l'écran — affinité DÉCLARÉE (Q2 ÷ 10, ou Q2 ÷ Q1 selon la méthode). */
function regleEcran(regles: Regles | null, p: RegleProduit | undefined, secteurs: { id: string; nom: string }[]): RegleEcran | null {
  if (!regles || !p || (p.sourceAffinite ?? "DECLAREE") !== "DECLAREE") return null;
  const seuilParSecteur: Record<string, number> = {};
  for (const s of secteurs) { const e = exceptionDuSecteur(p, s); if (e?.seuilAffinite !== undefined) seuilParSecteur[s.id] = e.seuilAffinite; }
  return {
    hStatuts: regles.h.statuts, seuilPotentiel: p.seuilPotentiel, seuilAffinite: p.seuilAffinite, comparaison: p.comparaisonAffinite,
    potentielNulNonCible: regles.ciblage.potentielNulNonCible, potentielNulNA: !!regles.ciblage.potentielNulNA,
    methode: p.methodeAffinite, seuilParSecteur,
  };
}

/** La synthèse : une carte par secteur de la BU (et « Sans secteur » si des fiches n'en ont aucun). */
function Synthese({ panel, secteurs, toutesLignes, regles, regleP1 }: {
  panel: LignePanel[]; secteurs: SecteurBu[]; toutesLignes: boolean; regles: Regles; regleP1: RegleProduit | undefined;
}) {
  const capacite = regles.capacite ?? PROPOSITION.capacite;
  const grilleDe = (id: string | null) => (regles.grille ? grilleDuSecteur(regles.grille, id) : { ...PROPOSITION.grille });
  const lettreDe = (l: LignePanel): { lettre: Lettre; inOut: "IN" | "OUT" | null } => ({ lettre: l.resultat?.lettre ?? "NA", inOut: l.inOut });
  const aDesLignes = new Set(panel.map((l) => l.secteurId));
  const montres = secteurs.filter((s) => (toutesLignes ? s.actif : false) || aDesLignes.has(s.id));
  const cartes: CarteSecteur[] = montres.map((s) => ({
    id: s.id, nom: s.nom, kams: s.kams.map((k) => k.nom),
    matrice: matriceDe(panel.filter((l) => l.secteurId === s.id).map(lettreDe)),
    grille: grilleDe(s.id),
    seuilPropre: !!exceptionDuSecteur(regleP1, s),
  }));
  const sans = panel.filter((l) => !l.secteurId);
  if (sans.length) cartes.push({ id: "__sans", nom: "Sans secteur", kams: [], matrice: matriceDe(sans.map(lettreDe)), grille: grilleDe(null), seuilPropre: false, sansSecteur: true });
  const kams = new Set(montres.flatMap((s) => s.kams.map((k) => k.id)));
  const lettres = panel.map((l) => l.resultat?.lettre ?? "NA");
  const tuiles: Tuiles = {
    cibles: lettres.filter((x) => x !== "NC").length,
    secteurs: montres.length,
    kams: kams.size,
    hautPotentiel: lettres.filter((x) => x === "H" || x === "A" || x === "B").length,
    na: lettres.filter((x) => x === "NA").length,
    contacts: cartes.reduce((s, c) => s + contactsDe(c.matrice, c.grille).total, 0),
    possibles: kams.size * capacite.contactsParJour * capacite.joursParCycle,
  };
  return <SyntheseVue tuiles={tuiles} cartes={cartes} capacite={capacite} grillePubliee={!!regles.grille && !!regles.capacite} />;
}

async function CyclesSection({ strategieId, cycleDemande, peutGerer, moi }: { strategieId: string; cycleDemande?: string; peutGerer: boolean; moi: string | null }) {
  const cycles = await prisma.segmentationCycle.findMany({ where: { strategieId }, orderBy: { debut: "desc" }, select: { id: true, libelle: true, statut: true, debut: true, fin: true } });
  const cycleId = cycles.find((c) => c.id === cycleDemande)?.id ?? cycles.find((c) => c.statut === "OUVERT")?.id ?? cycles[0]?.id ?? null;
  const cycle = cycleId ? await chargerCycle(cycleId) : null;
  return <CyclesVue strategieId={strategieId} cycles={cycles} cycle={cycle} peutGerer={peutGerer} moi={moi} />;
}

/** L'historique : versions des règles, imports, et chaque lettre forcée (en vigueur ou levée), avec son motif. */
async function Historique({ strategieId, doctorIds }: { strategieId: string; doctorIds: string[] }) {
  const [versions, imports, forcages] = await Promise.all([
    prisma.segmentationRegle.findMany({ where: { strategieId }, orderBy: { version: "desc" }, select: { version: true, note: true, publieeLe: true } }),
    prisma.segmentationImport.findMany({ where: { strategieId }, orderBy: { createdAt: "desc" }, select: { id: true, nomFichier: true, createdAt: true, feuille: true } }),
    prisma.segmentationDerogation.findMany({
      where: { strategieId, doctorId: { in: doctorIds } }, orderBy: { creeLe: "desc" }, take: 200,
      select: { id: true, nature: true, valeur: true, valeurCalculee: true, motif: true, creeLe: true, leveeLe: true, doctor: { select: { name: true } } },
    }),
  ]);
  const libelle = (nature: string, v: string | null) => (v === null ? "—" : nature === "CIBLAGE" ? (v === "NON_CIBLE" || v === "NC" ? "non ciblé" : v === "CIBLE" ? "ciblé" : v) : v === "NC" ? "non ciblé" : v);
  const jour = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" });
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section className="surface space-y-2 rounded-xl p-4">
        <h2 className="text-sm font-semibold">Versions des règles</h2>
        {versions.length === 0 && <p className="text-sm text-muted-foreground">Aucune version publiée.</p>}
        {versions.map((v) => <p key={v.version} className="text-sm [overflow-wrap:anywhere]"><span className="font-medium">v{v.version}</span> · {jour(v.publieeLe)} {v.note ? `· ${v.note}` : ""}</p>)}
      </section>
      <section className="surface space-y-2 rounded-xl p-4">
        <h2 className="text-sm font-semibold">Imports</h2>
        {imports.length === 0 && <p className="text-sm text-muted-foreground">Aucun import.</p>}
        {imports.map((i) => <p key={i.id} className="text-sm [overflow-wrap:anywhere]">{i.nomFichier} · feuille {i.feuille ?? "—"} · {jour(i.createdAt)}</p>)}
      </section>
      <section className="surface space-y-2 rounded-xl p-4 md:col-span-2">
        <h2 className="text-sm font-semibold">Potentiels forcés à la main</h2>
        {forcages.length === 0 && <p className="text-sm text-muted-foreground">Aucun.</p>}
        {forcages.map((f) => (
          <p key={f.id} className={cn("text-sm [overflow-wrap:anywhere]", f.leveeLe && "text-muted-foreground")}>
            {jour(f.creeLe)} · <span className="font-medium">{f.doctor.name}</span> : {libelle(f.nature, f.valeur)} (calculé : {libelle(f.nature, f.valeurCalculee)}) — {f.motif}{f.leveeLe ? ` · levé le ${jour(f.leveeLe)}` : ""}
          </p>
        ))}
      </section>
    </div>
  );
}
