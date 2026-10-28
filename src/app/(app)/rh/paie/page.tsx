import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getBudgetCategoryOptions } from "@/lib/queries/budget";
import { PageHeader } from "@/components/shared/page-header";
import { toNumber } from "@/lib/utils";
import { PayrollMatrix, type PayrollRow, type PayrollCell } from "./payroll-matrix";
import { VirementsPaie, type CarteEntite, type MoisCarte } from "./virements-paie";
import { defaultEmployerCost } from "@/lib/hr/payroll-cost";
import { entryCost } from "@/lib/hr/payroll-cost";
import { masseMensuelleParEntite, type LigneMasseMensuelle } from "@/lib/hr/payroll-mass";
import type { ColonneMasse } from "./masse-mensuelle";
import { RattacherSansEntite, type SalarieSansEntite } from "./rattacher-sans-entite";
import { etatVirement, etatSalaire, moisDeLEntite, saisiAvantLeCentre, type VirementDuMois, type EtatSalaire } from "@/lib/hr/virement-paie";
import { instantDuCentreDePaie } from "@/lib/hr/paie-centre";
import { getMyCompanies, myCompanyWhere } from "@/lib/company";
import { getRhData } from "@/lib/queries/hr";
import { AdvanceApprovals, type AdvanceRow } from "../advance-approvals";
import { lireSensiblesPour } from "@/lib/coffre/lecture";

export const dynamic = "force-dynamic";

/**
 * Onglet Paie des RH (maquette « Paie », Direction 07/10) : en tête le mois en cours entité par
 * entité (« Envoyer la paie »), puis la grille salariés × mois avec la masse salariale en pied,
 * l'alerte des salariés sans entité, les avances à trancher.
 */
export default async function PaiePage(props: { searchParams: Promise<{ year?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("RH");
  if (!userCan(user, "RH", "UPDATE")) redirect("/mon-dossier");

  const year = Math.min(2100, Math.max(2020, Number(searchParams.year) || new Date().getFullYear()));

  // LA PAIE EST SÉPARÉE PAR ENTITÉ. Le groupe compte plusieurs sociétés ; chacune paie ses
  // salaires et rend ses comptes. Une matrice qui les mélange affiche une masse salariale qui
  // n'est le chiffre d'aucune d'elles — et c'est pourtant celui qu'on lisait. Le sélecteur
  // d'entité de la barre supérieure sépare donc réellement la paie, et la portée est VALIDÉE
  // contre les droits : « toutes les entités » veut dire « toutes celles auxquelles j'ai droit ».
  const portee = await myCompanyWhere(user.id);

  const [employees, entries, budgetOptions, mesEntites] = await Promise.all([
    prisma.employee.findMany({
      where: { isActive: true, ...portee },
      select: {
        id: true, fullName: true, position: true, netToPay: true, grossSalary: true, baseSalary: true,
        employerCost: true, companyId: true, departmentId: true,
      },
      orderBy: { fullName: "asc" },
    }),
    // Chaque salaire avec SON virement et l'entité de son salarié : l'état « saisi / envoyé / viré »
    // se lit dessus (§118.176), et la carte d'une entité compte exactement ce que l'envoi couvrira.
    prisma.payrollEntry.findMany({
      where: { year },
      include: {
        employee: { select: { companyId: true } },
        payrollWire: { select: { paidAt: true, expenseOrder: { select: { status: true, centralStatus: true } } } },
      },
    }),
    // Options de catégories budgétaires RESTREINTES aux enveloppes ouvertes à ce compte
    // (encadrement strict — pas de fuite des libellés d'enveloppes non partagées).
    getBudgetCategoryOptions(undefined, user),
    getMyCompanies(user.id),
  ]);
  // L'INSTANT DE LA BASCULE : un salaire marqué payé avant lui a été VERSÉ par l'ancien circuit —
  // la carte ne le propose pas au centre, l'envoi ne le couvre pas (§118.176).
  const depuisLeCentre = await instantDuCentreDePaie();

  // LES FICHES DE PAIE DÉJÀ DÉPOSÉES — chargées EN LOT et rendues à l'écran.
  //
  // Elles étaient bien enregistrées (dossier RH du salarié), mais la matrice n'en disait rien :
  // on sortait de l'écran, on revenait, et plus aucune trace du bulletin qu'on venait de joindre.
  // Un fichier qu'on ne peut pas revoir depuis l'endroit où on l'a déposé est, pour celui qui
  // l'a déposé, un fichier perdu.
  const payslipIds = entries.map((e) => e.payslipDocumentId).filter((v): v is string => Boolean(v));
  const payslips = payslipIds.length
    ? await prisma.employeeDocument.findMany({
        where: { id: { in: payslipIds } },
        select: { id: true, name: true, size: true, createdAt: true },
      })
    : [];
  const payslipById = new Map(payslips.map((d) => [d.id, d]));

  const byKey = new Map(entries.map((e) => [`${e.employeeId}:${e.month}`, e]));

  // ── LE VIREMENT DE LA PAIE, ENTITÉ PAR ENTITÉ (§118.176) ────────────────────────────────────
  //
  // L'état d'un salaire se lit sur sa ligne ET sur son virement — la même règle que l'envoi
  // (`moisDeLEntite`), pour que la carte n'offre jamais un bouton que l'action refuserait.
  const etatDe = (e: (typeof entries)[number]): EtatSalaire => etatSalaire({
    status: e.status, transactionId: e.transactionId, budgetTransferredAt: e.budgetTransferredAt,
    virement: e.payrollWire ? etatVirement({ paidAt: e.payrollWire.paidAt, ordre: e.payrollWire.expenseOrder }) : null,
    avantLeCentre: saisiAvantLeCentre(e, depuisLeCentre),
  });
  const idsPortee = typeof portee.companyId === "string"
    ? [portee.companyId]
    : portee.companyId && typeof portee.companyId === "object" ? portee.companyId.in : mesEntites.map((c) => c.id);
  const entitesDeLaPaie = mesEntites.filter((c) => idsPortee.includes(c.id));
  const virements = entitesDeLaPaie.length
    ? await prisma.payrollWire.findMany({
        where: { year, companyId: { in: entitesDeLaPaie.map((c) => c.id) } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, companyId: true, month: true, amount: true, createdAt: true, paidAt: true,
          expenseOrder: { select: { reference: true, status: true, centralStatus: true } },
        },
      })
    : [];
  const cartes: CarteEntite[] = entitesDeLaPaie.map((c) => {
    const label = c.shortName || c.name;
    // L'EFFECTIF de l'entité (salariés actifs de la portée) — le « sur M » de la carte du mois.
    const effectifEntite = employees.filter((emp) => emp.companyId === c.id);
    const mois: MoisCarte[] = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const saisis = effectifEntite.filter((emp) => byKey.get(`${emp.id}:${month}`)?.status === "PAID").length;
      const salaires = entries
        .filter((e) => e.month === month && e.employee?.companyId === c.id)
        .map((e) => ({ etat: etatDe(e), net: toNumber(e.net) }));
      const duMois: VirementDuMois[] = virements
        .filter((v) => v.companyId === c.id && v.month === month)
        .map((v) => ({
          id: v.id,
          reference: v.expenseOrder?.reference ?? null,
          montant: toNumber(v.amount),
          etat: etatVirement({ paidAt: v.paidAt, ordre: v.expenseOrder }),
          envoyeLe: v.createdAt.toISOString(),
          vireLe: v.paidAt ? v.paidAt.toISOString() : null,
        }));
      return {
        ...moisDeLEntite({ entite: label, year, month, salaires, virements: duMois }),
        virements: duMois, effectif: effectifEntite.length, saisis,
      };
    });
    return { companyId: c.id, label, mois };
  });
  // Les salaires saisis de salariés SANS entité : leur paie ne peut partir d'aucune carte — on le dit.
  const sansEntite = Array.from({ length: 12 }, (_, i) => entries.filter((e) => (
    e.month === i + 1 && !e.employee?.companyId && etatDe(e) === "SAISI"
  )).length);
  // LE MOIS EN COURS : celui du calendrier pour l'année courante ; sinon le dernier mois où un
  // salaire est saisi (à défaut décembre pour une année passée, janvier pour une année à venir).
  const maintenant = new Date();
  const anneeCourante = maintenant.getFullYear();
  const moisCourant = anneeCourante === year ? maintenant.getMonth() + 1 : null;
  const dernierMoisSaisi = entries.reduce((m, e) => (e.status === "PAID" && e.month > m ? e.month : m), 0);
  const moisInitial = moisCourant ?? (dernierMoisSaisi || (year < anneeCourante ? 12 : 1));
  // La grille : les 6 derniers mois jusqu'au mois courant (décembre pour une année passée).
  const finFenetre = moisCourant ?? (year < anneeCourante ? 12 : 6);
  const futurDes = moisCourant ? moisCourant + 1 : year < anneeCourante ? 13 : 1;

  // LA MASSE SALARIALE, SOCIÉTÉ PAR SOCIÉTÉ ET MOIS PAR MOIS (Direction, 04/10/2026). C'est le
  // chiffre que chaque entité doit reconnaître comme le sien ; consolidé, il n'est celui d'aucune.
  // Calculé sur les lignes PAYÉES de l'année et sur les seuls salariés de la portée — le même coût
  // employeur que celui imputé au budget. L'entité d'une ligne est celle de la FICHE SALARIÉ : une
  // ligne de paie n'en porte aucune à elle.
  const empById = new Map(employees.map((e) => [e.id, e]));
  const payees = entries.filter((e) => e.status === "PAID" && empById.has(e.employeeId));
  const lignes: (LigneMasseMensuelle & { employeeId: string })[] = payees.map((e) => ({
    employeeId: e.employeeId,
    companyId: empById.get(e.employeeId)!.companyId ?? null,
    month: e.month,
    cost: entryCost({
      employerCost: e.employerCost != null ? toNumber(e.employerCost) : null,
      gross: toNumber(e.gross), bonuses: toNumber(e.bonuses), deductions: toNumber(e.deductions),
    }),
    net: toNumber(e.net),
  }));
  const masse = masseMensuelleParEntite(lignes);
  const nomEntite = new Map(mesEntites.map((c) => [c.id, c.shortName || c.name]));
  const colonnesMasse: ColonneMasse[] = [...masse.entries()]
    .map(([companyId, m]) => ({
      companyId,
      label: companyId ? (nomEntite.get(companyId) ?? "Entité inconnue") : "Sans entité",
      masse: m,
    }))
    .sort((a, b) => (a.companyId ? 0 : 1) - (b.companyId ? 0 : 1) || a.label.localeCompare(b.label, "fr"));

  // LES SALARIÉS SANS ENTITÉ — QUI, avec ce qu'ils pèsent, et le geste qui les rattache.
  const sansEntiteSalaries: SalarieSansEntite[] = employees
    .filter((e) => !e.companyId)
    .map((e) => {
      const siens = lignes.filter((l) => l.employeeId === e.id);
      return {
        id: e.id, nom: e.fullName, poste: e.position ?? null,
        cout: siens.reduce((a, l) => a + l.cost, 0),
        net: siens.reduce((a, l) => a + l.net, 0),
        salaires: siens.length,
      };
    })
    .sort((a, b) => b.cout - a.cout || a.nom.localeCompare(b.nom, "fr"));
  // LE COFFRE (refonte V2-E) : les salaires de fiche qui préremplissent l'envoi, lus par la politique et journalisés.
  const salaires = await lireSensiblesPour(user, {
    modele: "Employee", champs: ["baseSalary", "grossSalary", "netToPay", "employerCost"], geste: "Paie — préremplissage des salaires",
    lignes: employees.map((e) => ({ id: e.id, clair: e })),
  });
  const salaire = (id: string, champ: "baseSalary" | "grossSalary" | "netToPay" | "employerCost"): number | null => {
    const v = salaires.get(id)?.[champ]?.valeur;
    return v ? Number(v) : null;
  };
  const rows: PayrollRow[] = employees.map((emp) => ({
    employeeId: emp.id,
    name: emp.fullName,
    poste: emp.position ?? null,
    companyId: emp.companyId ?? null,
    // Pré-remplissage : brut depuis le salaire brut de la fiche (à défaut le salaire de base), net depuis le net à payer.
    defaultGross: salaire(emp.id, "grossSalary") ?? salaire(emp.id, "baseSalary"),
    // Ordre : le coût employeur de la fiche, à défaut le brut, à défaut le salaire de base — et
    // JAMAIS 0, qui se validerait sans qu'on le relise et amputerait la masse d'un salaire.
    defaultEmployerCost: defaultEmployerCost({
      employerCost: salaire(emp.id, "employerCost"),
      grossSalary: salaire(emp.id, "grossSalary"),
      baseSalary: salaire(emp.id, "baseSalary"),
    }),
    defaultNet: salaire(emp.id, "netToPay") ?? salaire(emp.id, "baseSalary"),
    months: Array.from({ length: 12 }, (_, i): PayrollCell => {
      const e = byKey.get(`${emp.id}:${i + 1}`);
      if (!e || e.status !== "PAID") return { state: "UNPAID" as const, amount: null, net: null, employerCost: null, entryId: e?.id ?? null, payslip: null };
      const doc = e.payslipDocumentId ? payslipById.get(e.payslipDocumentId) ?? null : null;
      const etat = etatDe(e);
      return {
        state: etat === "NON_SAISI" ? "UNPAID" : etat,
        // `amount` = BRUT (ligne de bulletin) ; `net` = ce que perçoit le salarié ;
        // `employerCost` = ce qui pèse sur le budget, et donc ce qu'on rouvre pour corriger.
        amount: toNumber(e.gross),
        net: toNumber(e.net),
        employerCost: e.employerCost != null ? toNumber(e.employerCost) : null,
        entryId: e.id,
        payslip: doc ? { id: doc.id, name: doc.name, sizeBytes: doc.size, addedAt: doc.createdAt.toISOString() } : null,
      };
    }),
  }));

  // Les avances se TRANCHENT avec le droit de valider des RH — la même règle que `decideAdvance`.
  const avances: AdvanceRow[] | null = userCan(user, "RH", "VALIDATE")
    ? (await getRhData(user.id)).advances.map((a) => ({
        id: a.id, employee: a.employee.fullName, amount: Number(a.amount),
        reason: a.reason, status: a.status, createdAt: a.createdAt.toISOString(),
      }))
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Paie ${year}`}
        description={entitesDeLaPaie.length > 0 ? entitesDeLaPaie.map((c) => c.shortName || c.name).join(" · ") : undefined}
      >
        <nav className="flex items-center gap-1.5" aria-label="Année de la paie">
          <Link href={`/rh/paie?year=${year - 1}`} aria-label={`Année ${year - 1}`} className="rounded-md border border-border bg-card p-2.5 hover:bg-secondary sm:p-1.5"><ChevronLeft className="h-4 w-4" /></Link>
          <span className="min-w-14 text-center text-sm font-semibold tabular-nums">{year}</span>
          <Link href={`/rh/paie?year=${year + 1}`} aria-label={`Année ${year + 1}`} className="rounded-md border border-border bg-card p-2.5 hover:bg-secondary sm:p-1.5"><ChevronRight className="h-4 w-4" /></Link>
        </nav>
      </PageHeader>

      {/* EN TÊTE, LE MOIS EN COURS — entité par entité : ce qui est saisi, la somme, « Envoyer la paie ». */}
      <VirementsPaie
        year={year} cartes={cartes} sansEntite={sansEntite} moisInitial={moisInitial}
        budgetOptions={budgetOptions.map((b) => ({ id: b.id, label: b.label }))}
      />

      {sansEntiteSalaries.length > 0 && (
        <RattacherSansEntite
          year={year} salaries={sansEntiteSalaries}
          entites={mesEntites.map((c) => ({ id: c.id, label: c.shortName || c.name }))}
        />
      )}

      {/* LA GRILLE salariés × mois — la masse salariale par entité est son pied (plus de carte à part). */}
      <PayrollMatrix
        year={year} rows={rows}
        entites={entitesDeLaPaie.map((c) => ({ id: c.id, label: c.shortName || c.name }))}
        colonnesMasse={colonnesMasse}
        moisCourant={moisCourant} futurDes={futurDes} finFenetre={finFenetre}
      />

      {/* LES AVANCES SUR SALAIRE — venues de l'ancien tableau de bord des RH (Direction, 06/10) : c'est de l'argent versé
          au salarié, elles se tranchent donc à côté de sa paie. */}
      {avances && <AdvanceApprovals rows={avances} />}
    </div>
  );
}
