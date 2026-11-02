import { describe, expect, it } from "vitest";
import { chiffreDeControle } from "@/modules/assistant-ia/partage";
import { classerPiece, estNatureLocale } from "./classement";
import { NATURES_LOCALES, NATURES_PIECE, type NaturePiece } from "./types";

/**
 * Le corpus : des textes de pièces ANONYMISÉS (noms, numéros et montants inventés), tels que la
 * couche texte ou l'OCR local les rend — en-têtes administratifs, fautes d'accents, arabe compris.
 */

const c = (s: string) => String(chiffreDeControle(s));

function td3(pays: string, nom: string, prenoms: string, numero: string, naissance: string, sexe: string, expiration: string): string {
  const l1 = `P<${pays}${nom}<<${prenoms.replace(/ /g, "<")}`.padEnd(44, "<");
  const num = numero.padEnd(9, "<");
  const perso = "".padEnd(14, "<");
  const corps = `${num}${c(num)}${pays}${naissance}${c(naissance)}${sexe}${expiration}${c(expiration)}${perso}${c(perso)}`;
  const composite = corps.slice(0, 10) + corps.slice(13, 20) + corps.slice(21, 43);
  return `${l1}\n${corps}${c(composite)}`;
}

function td1(pays: string, numero: string, naissance: string, sexe: string, expiration: string, nom: string, prenom: string): string {
  const l1 = `ID${pays}${numero}${c(numero)}`.padEnd(30, "<");
  const l2 = `${naissance}${c(naissance)}${sexe}${expiration}${c(expiration)}${pays}`.padEnd(29, "<") + "0";
  const l3 = `${nom}<<${prenom}`.padEnd(30, "<");
  return `${l1}\n${l2}\n${l3}`;
}

interface Cas { attendu: NaturePiece; nom: string; mime?: string; texte: string }

const CORPUS: Cas[] = [
  // ── PASSEPORT ──
  { attendu: "PASSEPORT", nom: "scan_0012.jpg", texte: `REPUBLIQUE ALGERIENNE DEMOCRATIQUE ET POPULAIRE\nPASSEPORT / PASSPORT\nType P  Code DZA\nNom / Surname: BENALI\nPrénoms / Given names: KARIM\nDate de naissance 12.04.1984\n${td3("DZA", "BENALI", "KARIM", "198765432", "840412", "M", "310915")}` },
  { attendu: "PASSEPORT", nom: "passeport-dr-x.pdf", texte: `PASSPORT\nUnited Kingdom of Great Britain\nSurname SMITH Given names JANE\nDate of expiry 03 MAR 2030\n${td3("GBR", "SMITH", "JANE", "533401821", "790302", "F", "300303")}` },
  { attendu: "PASSEPORT", nom: "IMG_2231.png", texte: `جواز السفر\nالجمهورية الجزائرية الديمقراطية الشعبية\n${td3("DZA", "HADJ", "AMINA SARA", "201133447", "920118", "F", "290611")}` },
  { attendu: "PASSEPORT", nom: "doc.pdf", texte: `RÉPUBLIQUE FRANÇAISE\nPASSEPORT\nNom : DURAND\nPrénoms : PAUL\nNationalité : Française\nLieu de naissance : LYON\nDate de délivrance : 02.02.2022\nDate d'expiration : 01.02.2032\nAutorité : Préfecture du Rhône` },
  { attendu: "PASSEPORT", nom: "mrz.txt", texte: td3("TUN", "TRABELSI", "MEHDI", "X1234567", "880101", "M", "280101") },

  // ── CNI ──
  { attendu: "CNI", nom: "cni_recto_verso.jpg", texte: `REPUBLIQUE ALGERIENNE DEMOCRATIQUE ET POPULAIRE\nCARTE NATIONALE D'IDENTITE\nNom: MEZIANE Prénom: YACINE\nDate de naissance: 05.06.1990 Lieu de naissance: ORAN\nNIN 109900512345678901\n${td1("DZA", "123456789", "900605", "M", "330605", "MEZIANE", "YACINE")}` },
  { attendu: "CNI", nom: "scan.pdf", texte: `CARTE NATIONALE D'IDENTITÉ\nNom : LEROY\nPrénom(s) : CLAIRE\nNé(e) le : 14.09.1987 à NANTES\nNationalité : Française\nDate d'expiration : 13.09.2031` },
  { attendu: "CNI", nom: "IMG_8812.jpg", texte: `بطاقة التعريف الوطنية\nالجمهورية الجزائرية الديمقراطية الشعبية\nاللقب: بوزيد الاسم: سمير\n${td1("DZA", "987654321", "851120", "M", "301120", "BOUZID", "SAMIR")}` },
  { attendu: "CNI", nom: "id-card.png", texte: `NATIONAL IDENTITY CARD\nSurname: OKAFOR\nGiven names: CHIDI\nNationality: NGA\nDate of expiry: 2029-04-30\nPlace of birth: LAGOS` },
  { attendu: "CNI", nom: "verso.jpg", texte: td1("FRA", "X4RTBPFW4", "870914", "F", "310913", "LEROY", "CLAIRE") },

  // ── PERMIS DE CONDUIRE ──
  { attendu: "PERMIS_CONDUIRE", nom: "permis.jpg", texte: `PERMIS DE CONDUIRE\nREPUBLIQUE ALGERIENNE\n1. HAMIDI\n2. RACHID\n3. 03.03.1980 ALGER\n4a. 10.01.2018 4b. 09.01.2028\n9. B` },
  { attendu: "PERMIS_CONDUIRE", nom: "scan_44.pdf", texte: `DRIVING LICENCE\nUK\n1. JONES 2. MARK\n4a. 01.05.2015\nCategories: B BE` },
  { attendu: "PERMIS_CONDUIRE", nom: "IMG_1.jpg", texte: `رخصة السياقة\nاللقب: سعيدي\nالاسم: نبيل\nCatégories : B` },
  { attendu: "PERMIS_CONDUIRE", nom: "document.pdf", texte: `Permis de conduire\nNom : MARTIN\nDate de délivrance : 12/06/2019\nCatégorie : B` },

  // ── VISA ──
  { attendu: "VISA", nom: "visa_schengen.jpg", texte: `VISA\nVALABLE POUR ETATS SCHENGEN\nDU 01-11-26 AU 30-11-26\nTYPE DE VISA C\nNOMBRE D'ENTREES MULT\nDUREE DE SEJOUR 15 JOURS\nVCFRABENALI<<KARIM<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n1987654321DZA8404121M3011305<<<<<<<<<<<<<<<<` },
  { attendu: "VISA", nom: "scan.pdf", texte: `VISA\nValid from 10/12/2026 until 10/03/2027\nVisa type: Business\nNumber of entries: Multiple\nDuration of stay: 90 days\nPassport number: 198765432` },
  { attendu: "VISA", nom: "visa-dubai.pdf", texte: `ENTRY PERMIT / VISA\nVisa type: Tourist\nNumber of entries: Single\nDuration of stay: 30 days` },
  { attendu: "VISA", nom: "IMG.jpg", texte: `تأشيرة\nنوع التأشيرة: عمل\nVisa type: Work\nDuration of stay: 60 days` },

  // ── DEVIS ──
  { attendu: "DEVIS", nom: "Devis_Imprimerie.pdf", texte: `IMPRIMERIE DU CENTRE SARL\nRC : 16/00-1234567B19  NIF : 001216123456789\nDEVIS N° D-2026-0145\nAlger, le 12/10/2026\nDésignation Qté PU HT Montant\nKakémono 85x200 10 4 500,00 45 000,00\nTotal HT 45 000,00\nTVA 19 % 8 550,00\nTotal TTC 53 550,00\nValidité de l'offre : 30 jours` },
  { attendu: "DEVIS", nom: "proforma.pdf", texte: `EVENTS PLUS\nFACTURE PROFORMA N° 2026/88\nClient : Adventum Pharma\nLocation salle 1 jour 250 000,00\nTotal HT 250 000,00\nTotal TTC 297 500,00\nOffre valable 15 jours` },
  { attendu: "DEVIS", nom: "quote.pdf", texte: `ACME MEDICAL LTD\nQUOTATION No. Q-7781\nDate: 03/09/2026\nItem Qty Unit price\nStand 9m2 1 3,200.00\nQuote valid for 30 days` },
  { attendu: "DEVIS", nom: "scan.pdf", texte: `مؤسسة النور للطباعة\nعرض أسعار رقم 45\nالتاريخ: 2026/10/02\nالمجموع خارج الرسم 120000\nصالح لمدة 30 يوما` },

  // ── FACTURE ──
  { attendu: "FACTURE", nom: "F-2026-014.pdf", texte: `IMPRIMERIE DU CENTRE SARL\nNIF : 001216123456789\nFACTURE N° 2026/014\nAlger, le 20/10/2026\nSuivant devis N° D-2026-0145\nKakémono 85x200 10 4 500,00 45 000,00\nTotal HT 45 000,00\nTVA 19 % 8 550,00\nTimbre 535,00\nTotal TTC 54 085,00\nArrêtée la présente facture à la somme de cinquante-quatre mille quatre-vingt-cinq dinars` },
  { attendu: "FACTURE", nom: "invoice_553.pdf", texte: `GLOBAL CONGRESS SERVICES\nINVOICE # 553\nInvoice date: 2026-09-01\nRegistration fees 3 x 650.00 EUR\nTotal HT 1 950,00\nAmount due: 1,950.00 EUR\nDue date: 2026-10-01` },
  { attendu: "FACTURE", nom: "fact.pdf", texte: `TRAITEUR EL BARAKA\nFacture n° : FA-889\nDate : 05/10/2026\nPause café 120 personnes\nNet à payer : 96 000,00 DA` },
  { attendu: "FACTURE", nom: "IMG_7.jpg", texte: `شركة الأمل للخدمات\nفاتورة رقم 2026/77\nالتاريخ 2026/09/15\nالمبلغ الواجب الدفع 54000 دج` },

  // ── BON DE COMMANDE ──
  { attendu: "BON_DE_COMMANDE", nom: "BC-2026-031.pdf", texte: `ADVENTUM PHARMA SPA\nBON DE COMMANDE N° BC-2026-031\nFournisseur : Imprimerie du Centre\nSuivant votre devis N° D-2026-0145\nKakémono 85x200 10 4 500,00\nTotal HT 45 000,00\nDélai de livraison : 7 jours\nAdresse de livraison : Zone industrielle, Alger` },
  { attendu: "BON_DE_COMMANDE", nom: "po.pdf", texte: `PURCHASE ORDER\nPO No. 4500012345\nVendor: ACME Medical Ltd\nPlease supply the following items\nBooth 9m2 1 3,200.00` },
  { attendu: "BON_DE_COMMANDE", nom: "commande_traiteur.pdf", texte: `Bon de commande\nN° 2026-112\nMerci de nous livrer 120 coffrets repas le 12/11/2026\nLieu de livraison : Hôtel Sofitel, Alger` },
  { attendu: "BON_DE_COMMANDE", nom: "scan.pdf", texte: `أمر شراء رقم 31\nالمورد: مطبعة الوسط\nالكمية 10` },

  // ── AVOIR ──
  { attendu: "AVOIR", nom: "avoir.pdf", texte: `IMPRIMERIE DU CENTRE SARL\nAVOIR N° AV-2026-003\nSur facture N° 2026/014\nRetour de marchandises : 2 kakémonos défectueux\nTotal HT 9 000,00\nTotal TTC 10 710,00\nMontant en votre faveur` },
  { attendu: "AVOIR", nom: "credit-note.pdf", texte: `CREDIT NOTE No. CN-2041\nRelated to invoice # 553\nRefund of 1 cancelled registration\nCredit in your favour: 650.00 EUR` },
  { attendu: "AVOIR", nom: "FA_avoir_12.pdf", texte: `Facture d'avoir n° 12\nAnnule et remplace la facture N° FA-889\nRemboursement pause café non servie` },
  { attendu: "AVOIR", nom: "doc.pdf", texte: `إشعار دائن رقم 7\nبخصوص الفاتورة رقم 77\nإرجاع البضاعة` },

  // ── BON DE LIVRAISON ──
  { attendu: "BON_LIVRAISON", nom: "BL_2026_77.pdf", texte: `IMPRIMERIE DU CENTRE SARL\nBON DE LIVRAISON N° BL-2026-077\nSuivant BC N° BC-2026-031\nDésignation Quantité livrée\nKakémono 85x200 10\nLivreur : M. K.\nReçu par : ________ Signature du réceptionnaire` },
  { attendu: "BON_LIVRAISON", nom: "delivery.pdf", texte: `DELIVERY NOTE No. DN-5521\nItems: 3 boxes\nDelivered by: DHL\nReceived by: __________` },
  { attendu: "BON_LIVRAISON", nom: "bl.jpg", texte: `Bordereau de livraison\nN° 3341\nQté livrée : 50 cartons\nChauffeur : A. B.` },
  { attendu: "BON_LIVRAISON", nom: "scan.pdf", texte: `وصل التسليم رقم 12\nالمستلم: ________` },

  // ── CONTRAT ──
  { attendu: "CONTRAT", nom: "contrat_prestation.pdf", texte: `CONTRAT DE PRESTATION DE SERVICES\nEntre les soussignés :\nADVENTUM PHARMA SPA, ci-après dénommée « le Client »\nEt EVENTS PLUS SARL, ci-après dénommée « le Prestataire »\nArticle 1 – Objet du contrat\nArticle 2 – Durée du contrat\nArticle 9 – Résiliation\nFait en deux exemplaires à Alger` },
  { attendu: "CONTRAT", nom: "agreement.pdf", texte: `SERVICE AGREEMENT\nThis Agreement is made by and between ACME Ltd (hereinafter "the Supplier") and Adventum Pharma\nArticle 1 Scope\nTermination: either party may terminate with 30 days notice\nIN WITNESS WHEREOF the parties have signed` },
  { attendu: "CONTRAT", nom: "contrat_travail.pdf", texte: `Contrat de travail à durée indéterminée\nEntre les soussignés : la société X, ci-après désignée l'Employeur, et M. Y\nArticle premier : engagement\nLu et approuvé` },
  { attendu: "CONTRAT", nom: "doc.pdf", texte: `عقد تقديم خدمات\nالطرف الأول: شركة أدفنتوم فارما\nالطرف الثاني: مؤسسة النور\nالمادة 1: موضوع العقد` },

  // ── CONVENTION ──
  { attendu: "CONVENTION", nom: "convention_stage.pdf", texte: `CONVENTION DE STAGE\nEntre les soussignés : l'Université d'Alger 1 et ADVENTUM PHARMA SPA, ci-après dénommée « l'organisme d'accueil »\nArticle 1 – Objet de la convention\nDurée de la convention : 3 mois` },
  { attendu: "CONVENTION", nom: "partenariat.pdf", texte: `Convention de partenariat scientifique\nEntre la Société Algérienne de Cardiologie, ci-après désignée « la SAC », et Adventum Pharma\nArticle 1 : objet\nFait en deux exemplaires` },
  { attendu: "CONVENTION", nom: "mou.pdf", texte: `MEMORANDUM OF UNDERSTANDING\nBetween the undersigned: Algiers University Hospital and Adventum Pharma (hereinafter "the Partners")\nArticle 1 Purpose\nTermination clause` },
  { attendu: "CONVENTION", nom: "doc.pdf", texte: `اتفاقية شراكة\nالطرف الأول: الجمعية الجزائرية لطب القلب\nالطرف الثاني: أدفنتوم فارما\nالمادة الأولى: الموضوع` },

  // ── RIB ──
  { attendu: "RIB", nom: "rib_fournisseur.pdf", texte: `RELEVÉ D'IDENTITÉ BANCAIRE\nTitulaire du compte : IMPRIMERIE DU CENTRE SARL\nDomiciliation : BNA Agence Didouche\nCode banque 001 Code agence 00123\nRIB : 001 00123 0300000123 45\nClé RIB 45` },
  { attendu: "RIB", nom: "scan.jpg", texte: `RIB\nBanque Extérieure d'Algérie\nCompte n° 002 00456 1234567890 12\nTitulaire du compte : M. K. B.` },
  { attendu: "RIB", nom: "bank-details.pdf", texte: `BANK ACCOUNT DETAILS\nAccount holder: ACME Medical Ltd\nIBAN: GB29 NWBK 6016 1331 9268 19\nBIC / SWIFT: NWBKGB2L\nBank code: 601613` },
  { attendu: "RIB", nom: "doc.pdf", texte: `كشف الهوية البنكية\nصاحب الحساب: مؤسسة النور\n00300789012345678901` },

  // ── REGISTRE DU COMMERCE ──
  { attendu: "REGISTRE_COMMERCE", nom: "rc.pdf", texte: `CENTRE NATIONAL DU REGISTRE DU COMMERCE\nEXTRAIT DU REGISTRE DU COMMERCE\nN° RC : 16/00-1234567B19\nRaison sociale : IMPRIMERIE DU CENTRE\nForme juridique : SARL\nCapital social : 1 000 000 DA\nSiège social : Alger\nActivités exercées : 105201 Imprimerie` },
  { attendu: "REGISTRE_COMMERCE", nom: "kbis.pdf", texte: `Registre du commerce et des sociétés\nExtrait Kbis\nForme juridique : SAS\nDate d'immatriculation : 03/04/2015\nSiège social : Paris\nActivité principale : conseil` },
  { attendu: "REGISTRE_COMMERCE", nom: "scan.pdf", texte: `مستخرج من السجل التجاري\nالمركز الوطني للسجل التجاري\nرقم السجل: 16/00-7654321B20` },
  { attendu: "REGISTRE_COMMERCE", nom: "IMG_44.jpg", texte: `REPUBLIQUE ALGERIENNE\nMinistère du Commerce\nCNRC\nRegistre du commerce\nActivité exercée : Commerce de gros de produits pharmaceutiques\nForme juridique : SPA` },

  // ── ATTESTATION NIF ──
  { attendu: "ATTESTATION_NIF", nom: "attestation_nif.pdf", texte: `MINISTERE DES FINANCES\nDIRECTION GENERALE DES IMPOTS\nATTESTATION D'IMMATRICULATION FISCALE\nRaison sociale : IMPRIMERIE DU CENTRE\nNIF : 001216123456789` },
  { attendu: "ATTESTATION_NIF", nom: "scan.pdf", texte: `Direction générale des impôts\nAttestation de numéro d'identification fiscale\nNIF 000016098765432\nDélivrée le 12/02/2024` },
  { attendu: "ATTESTATION_NIF", nom: "nif.pdf", texte: `Attestation NIF\nDGI\nN.I.F. : 199916000111222` },
  { attendu: "ATTESTATION_NIF", nom: "doc.pdf", texte: `المديرية العامة للضرائب\nشهادة التسجيل الجبائي\nالرقم: 001216123456789` },

  // ── CARTE D'IMMATRICULATION FISCALE ──
  { attendu: "CARTE_IMMATRICULATION_FISCALE", nom: "carte_nif.jpg", texte: `DIRECTION GENERALE DES IMPOTS\nCARTE D'IMMATRICULATION FISCALE\nNIF : 001216123456789\nIMPRIMERIE DU CENTRE` },
  { attendu: "CARTE_IMMATRICULATION_FISCALE", nom: "scan.jpg", texte: `Carte d'identification fiscale\nNIF 000016098765432\nMinistère des finances` },
  { attendu: "CARTE_IMMATRICULATION_FISCALE", nom: "IMG.jpg", texte: `بطاقة التعريف الجبائي\nالمديرية العامة للضرائب\nNIF 199916000111222` },
  { attendu: "CARTE_IMMATRICULATION_FISCALE", nom: "carte.pdf", texte: `Carte NIF\nDGI\nN.I.F : 001616555666777` },

  // ── CV ──
  { attendu: "CV", nom: "cv_candidat.pdf", texte: `Samia K.\nPharmacienne\nCURRICULUM VITAE\nExpériences professionnelles\n2019 - 2023 Déléguée médicale, Laboratoire X\n2023 - présent Responsable produit, Laboratoire Y\nFormation\nDoctorat en pharmacie, Université d'Alger, 2018\nLangues : arabe, français, anglais\nCompétences : marketing, formation` },
  { attendu: "CV", nom: "resume.pdf", texte: `JOHN DOE\nRESUME\nWork experience\n2016 - 2020 Sales representative\n2020 - now Key account manager\nEducation\nMSc Pharmacology\nSkills: negotiation\nLanguages: English, French` },
  { attendu: "CV", nom: "document.docx", texte: `Karim B.\nIngénieur biomédical\nParcours professionnel\n2012 – 2018 : technicien\n2018 – aujourd'hui : ingénieur\nFormation\nCentres d'intérêt : lecture` },
  { attendu: "CV", nom: "scan.pdf", texte: `السيرة الذاتية\nالخبرات المهنية\nالتكوين\nاللغات: العربية، الفرنسية` },

  // ── DIPLÔME ──
  { attendu: "DIPLOME", nom: "diplome.jpg", texte: `REPUBLIQUE ALGERIENNE DEMOCRATIQUE ET POPULAIRE\nMinistère de l'Enseignement Supérieur\nUniversité d'Alger 1\nDIPLOME DE DOCTEUR EN PHARMACIE\nDécerné à Mlle K. S.\nMention : Très bien\nLe Recteur` },
  { attendu: "DIPLOME", nom: "scan.pdf", texte: `UNIVERSITY OF MANCHESTER\nDiploma\nThe degree of Master of Science\nhas been conferred upon John Doe\nwith Distinction\nVice-Chancellor` },
  { attendu: "DIPLOME", nom: "master.pdf", texte: `Université Paris Cité\nMaster Sciences du médicament\nM. Y. a obtenu le grade de Master\nMention : Bien\nLe Doyen de la Faculté` },
  { attendu: "DIPLOME", nom: "IMG.jpg", texte: `جامعة الجزائر\nشهادة الليسانس\nمنحت للطالب ...\nبتقدير جيد\nعميد الكلية` },

  // ── CARTE DE VISITE ──
  { attendu: "CARTE_VISITE", nom: "carte.jpg", texte: `Dr Nadia B.\nCardiologue\nClinique El Azhar\nTél : +213 555 12 34 56\nnadia.b@clinique-exemple.dz` },
  { attendu: "CARTE_VISITE", nom: "contact.vcf", mime: "text/vcard", texte: `BEGIN:VCARD\nVERSION:3.0\nFN:Karim B.\nTEL:+213661000000\nEND:VCARD` },
  { attendu: "CARTE_VISITE", nom: "IMG_0045.jpg", texte: `ACME Medical Ltd\nPeter Miller\nSales Manager EMEA\n+44 20 7946 0000\nwww.acme-medical.example` },
  { attendu: "CARTE_VISITE", nom: "scan.jpg", texte: `EVENTS PLUS\nSofiane M. – Gérant\n0550 11 22 33\ncontact@eventsplus.example\nwww.eventsplus.example` },

  // ── ATTESTATION ──
  { attendu: "ATTESTATION", nom: "attestation_travail.pdf", texte: `ADVENTUM PHARMA SPA\nATTESTATION DE TRAVAIL\nJe soussigné, Directeur des ressources humaines, atteste que M. K. B. est employé en qualité de délégué médical depuis le 01/03/2021.\nLa présente attestation est délivrée pour servir et valoir ce que de droit.` },
  { attendu: "ATTESTATION", nom: "certificat.pdf", texte: `CERTIFICATE OF ATTENDANCE\nThis is to certify that Dr N. B. attended the 12th Annual Meeting\nThe Organizing Committee` },
  { attendu: "ATTESTATION", nom: "scan.pdf", texte: `Attestation de participation\nNous soussignés, comité d'organisation, certifions que Dr Y. a participé aux journées.\nEn foi de quoi la présente est délivrée.` },
  { attendu: "ATTESTATION", nom: "doc.pdf", texte: `شهادة عمل\nيشهد المدير أن السيد ... يعمل لدينا\nسلمت هذه الشهادة للإدلاء بها` },

  // ── BULLETIN DE PAIE ──
  { attendu: "BULLETIN_PAIE", nom: "bulletin_octobre.pdf", texte: `ADVENTUM PHARMA SPA\nBULLETIN DE PAIE\nPériode de paie : octobre 2026\nMatricule : 0042\nSalaire de base 80 000,00\nRetenue SS 9 % 7 200,00\nIRG 9 800,00\nNet à payer 63 000,00` },
  { attendu: "BULLETIN_PAIE", nom: "payslip.pdf", texte: `PAYSLIP\nPay period: September 2026\nBase salary 4,000.00\nSocial security contributions 320.00\nNet pay 3,100.00` },
  { attendu: "BULLETIN_PAIE", nom: "scan.pdf", texte: `Fiche de paie\nSalaire de base : 65 000\nCotisations CNAS : 5 850\nSalaire net : 52 000` },
  { attendu: "BULLETIN_PAIE", nom: "doc.pdf", texte: `كشف الراتب\nالأجر القاعدي 70000\nاشتراكات الضمان الاجتماعي 6300` },

  // ── PROGRAMME DE CONGRÈS ──
  { attendu: "PROGRAMME_CONGRES", nom: "programme_sac.pdf", texte: `13e CONGRÈS NATIONAL DE CARDIOLOGIE\nPROGRAMME SCIENTIFIQUE\nJeudi 12 novembre 2026\n08h00 Accueil des participants – inscription\n09h00 Cérémonie d'ouverture\n10h30 Pause café\n11h00 Session 1 – Insuffisance cardiaque. Modérateurs : Pr A., Pr B.\n13h00 Déjeuner` },
  { attendu: "PROGRAMME_CONGRES", nom: "agenda.pdf", texte: `ANNUAL SYMPOSIUM ON DIABETES\nAGENDA\n09:00 Opening remarks\n09:30 Plenary session – Chair: Dr C.\n10:45 Coffee break\n11:15 Round table\n12:30 Lunch` },
  { attendu: "PROGRAMME_CONGRES", nom: "journees.pdf", texte: `Programme des journées pharmaceutiques\n14h00 Conférence inaugurale\n15h00 Table ronde – intervenants : Dr X., Dr Y.\n16h30 Clôture` },
  { attendu: "PROGRAMME_CONGRES", nom: "doc.pdf", texte: `برنامج المؤتمر الوطني لطب الأطفال\n09:00 افتتاح\n10:30 استراحة\n11:00 محاضرة` },

  // ── INVITATION ──
  { attendu: "INVITATION", nom: "invitation_soiree.pdf", texte: `INVITATION\nAdventum Pharma a l'honneur de vous inviter au lancement de son nouveau produit\nle 20 novembre 2026 à 19h, Hôtel Sofitel, Alger\nTenue de soirée\nRSVP avant le 15 novembre` },
  { attendu: "INVITATION", nom: "letter.pdf", texte: `Invitation letter\nDear Dr N. B.,\nWe have the pleasure of inviting you to attend the 12th Annual Meeting in Paris.\nPlease confirm your participation before 1 October.\nSincerely,` },
  { attendu: "INVITATION", nom: "carton.jpg", texte: `Vous êtes cordialement invité\nà la soirée scientifique du Club des pharmaciens\nMerci de confirmer votre présence` },
  { attendu: "INVITATION", nom: "doc.pdf", texte: `دعوة\nيسرنا دعوتكم لحضور اليوم العلمي\nيوم 20 نوفمبر` },

  // ── BILLET DE TRANSPORT ──
  { attendu: "BILLET_TRANSPORT", nom: "eticket.pdf", texte: `AIR ALGERIE\nE-TICKET RECEIPT / ITINERARY\nPassenger: BENALI/KARIM MR\nTicket number: 124 2156789012\nBooking reference (PNR): X7K2LM\nFlight AH 1000 ALG – CDG\nDeparture 12NOV 08:30 Terminal 1\nArrival 11:05\nBaggage: 2PC Economy` },
  { attendu: "BILLET_TRANSPORT", nom: "boarding.pdf", texte: `BOARDING PASS\nAF 1855\nFrom PARIS CDG To ALGIERS\nGate K42 Seat 23C\nBoarding 13:40` },
  { attendu: "BILLET_TRANSPORT", nom: "billet.pdf", texte: `Billet électronique\nN° de billet : 057-2400011122\nVol : TU 0511 Tunis – Alger\nClasse économique` },
  { attendu: "BILLET_TRANSPORT", nom: "doc.pdf", texte: `تذكرة إلكترونية\nرحلة رقم AH 3002\nرقم الحجز: QW12ER` },

  // ── RÉSERVATION D'HÔTEL ──
  { attendu: "RESERVATION_HOTEL", nom: "booking.pdf", texte: `BOOKING CONFIRMATION\nHotel Mercure Paris Centre\nConfirmation number: 884512\nCheck-in: 11 Nov 2026\nCheck-out: 14 Nov 2026\n3 nights – 1 room, 1 adult\nBreakfast included` },
  { attendu: "RESERVATION_HOTEL", nom: "confirmation.pdf", texte: `Confirmation de réservation\nHôtel El Aurassi, Alger\nDate d'arrivée : 20/11/2026\nDate de départ : 22/11/2026\nChambre double – petit-déjeuner inclus\n2 nuits` },
  { attendu: "RESERVATION_HOTEL", nom: "voucher.pdf", texte: `HOTEL VOUCHER\nGuest: Dr N. B.\nRoom type: Deluxe King\nCheck in 05/12 – Check out 08/12` },
  { attendu: "RESERVATION_HOTEL", nom: "doc.pdf", texte: `تأكيد الحجز\nفندق الأوراسي\n2 ليال\nغرفة مزدوجة` },

  // ── COURRIER ──
  { attendu: "COURRIER", nom: "lettre_ministere.pdf", texte: `ADVENTUM PHARMA SPA\nAlger, le 14/10/2026\nMonsieur le Directeur de la Pharmacie\nObjet : demande de rendez-vous\nMonsieur le Directeur,\nNous souhaiterions vous présenter notre gamme.\nVeuillez agréer, Monsieur le Directeur, l'expression de nos salutations distinguées.` },
  { attendu: "COURRIER", nom: "letter.pdf", texte: `Dear Sir,\nSubject: shipment delay\nWe regret to inform you that the shipment is delayed by two weeks.\nYours faithfully,\nACME Medical Ltd` },
  { attendu: "COURRIER", nom: "courrier.docx", texte: `Oran, le 02/09/2026\nObjet : changement d'adresse\nMadame, Monsieur,\nNous vous informons du transfert de notre siège.\nRecevez, Madame, Monsieur, nos sincères salutations.` },
  { attendu: "COURRIER", nom: "doc.pdf", texte: `السيد المدير العام\nالموضوع: طلب معلومات\nتقبلوا منا فائق الاحترام والتقدير` },

  // ── PROCÈS-VERBAL ──
  { attendu: "PROCES_VERBAL", nom: "pv_ago.pdf", texte: `PROCÈS-VERBAL DE L'ASSEMBLÉE GÉNÉRALE ORDINAIRE\nL'an deux mille vingt-six et le quinze octobre, les associés se sont réunis au siège social.\nÉtaient présents : M. A., M. B.\nOrdre du jour : approbation des comptes\nAprès délibération, l'assemblée décide d'approuver les comptes.\nLa séance est levée à 12h.` },
  { attendu: "PROCES_VERBAL", nom: "minutes.pdf", texte: `MINUTES OF THE MEETING\nAttendees: J. D., P. M.\nAgenda items: 1. Budget 2027\nIt was agreed to postpone the decision.\nThe meeting was adjourned at 5 pm.` },
  { attendu: "PROCES_VERBAL", nom: "pv_reception.pdf", texte: `PV de réception des travaux\nPrésents : le maître d'ouvrage, l'entreprise\nIl a été convenu de lever les réserves sous 15 jours.` },
  { attendu: "PROCES_VERBAL", nom: "doc.pdf", texte: `محضر اجتماع\nاجتمع مجلس الإدارة\nجدول الأعمال: الميزانية\nالحاضرون: ...` },

  // ── AUTRE ──
  { attendu: "AUTRE", nom: "photo.jpg", texte: "" },
  { attendu: "AUTRE", nom: "notes.txt", texte: `Penser à rappeler le fournisseur pour les kakémonos.\nVoir avec Samir mardi.` },
  { attendu: "AUTRE", nom: "tableau.xlsx", texte: `Produit;Quantité;Région\nCardiolex;120;Centre\nGlucofine;80;Est` },
  { attendu: "AUTRE", nom: "article.pdf", texte: `L'insuffisance cardiaque touche plusieurs millions de patients. Les nouvelles molécules réduisent la mortalité de façon significative selon plusieurs essais randomisés.` },
];

/** Les pièges : un mot de la nature voisine, à sa place ordinaire, ne doit pas la faire gagner. */
const PIEGES: (Cas & { pourquoi: string })[] = [
  {
    attendu: "PROGRAMME_CONGRES", pourquoi: "un programme qui demande d'apporter son passeport",
    nom: "programme.pdf",
    texte: `CONGRÈS MAGHRÉBIN D'ONCOLOGIE\nPROGRAMME\n08h30 Accueil et inscription\n09h00 Ouverture\n10h30 Pause café\n11h00 Session 2 – Modérateur : Pr K.\nInformations pratiques : apportez votre passeport et votre carte d'identité pour l'accès à la zone.\nPassport required – nationality and date of expiry will be checked.`,
  },
  {
    attendu: "FACTURE", pourquoi: "une facture qui cite le devis et le bon de commande",
    nom: "scan_778.pdf",
    texte: `EVENTS PLUS SARL\nFacture N° FA-2026-0091\nRéf. : Devis N° DV-2026-0042 et votre bon de commande N° BC-2026-031\nLocation salle 250 000,00\nTotal HT 250 000,00\nTotal TTC 297 500,00\nNet à payer 297 500,00`,
  },
  {
    attendu: "CONTRAT", pourquoi: "un contrat qui contient le RIB du prestataire",
    nom: "contrat_signe.pdf",
    texte: `CONTRAT DE PRESTATION\nEntre les soussignés : Adventum Pharma, ci-après dénommée « le Client », et Traiteur El Baraka, ci-après dénommé « le Prestataire »\nArticle 1 – Objet du contrat : restauration des journées scientifiques\nArticle 5 – Paiement : par virement sur le compte du Prestataire\nRIB : 001 00123 0300000123 45, domiciliation BNA Agence Didouche, titulaire du compte : Traiteur El Baraka\nArticle 8 – Résiliation\nFait en deux exemplaires`,
  },
  {
    attendu: "AVOIR", pourquoi: "un avoir qui cite la facture d'origine",
    nom: "document.pdf",
    texte: `AVOIR N° AV-12\nSur facture N° FA-2026-0091\nRemboursement d'une journée annulée\nTotal TTC 148 750,00`,
  },
  {
    attendu: "DEVIS", pourquoi: "un devis avec RC et NIF en pied de page",
    nom: "dv.pdf",
    texte: `DEVIS N° DV-88\nStand 9 m² 1 300 000,00\nTotal HT 300 000,00\nRegistre du commerce : 16/00-1234567B19 – NIF 001216123456789 – Capital social 1 000 000 DA – Siège social Alger`,
  },
  {
    attendu: "INVITATION", pourquoi: "une invitation rédigée en lettre (Objet, Monsieur, formule)",
    nom: "lettre.pdf",
    texte: `Alger, le 01/11/2026\nObjet : invitation\nMonsieur,\nNous avons le plaisir de vous inviter à notre soirée scientifique du 20 novembre.\nMerci de confirmer votre présence.\nVeuillez agréer, Monsieur, nos salutations distinguées.`,
  },
  {
    attendu: "CV", pourquoi: "un CV qui cite des diplômes",
    nom: "cv.pdf",
    texte: `CURRICULUM VITAE\nFormation\nDiplôme de docteur en pharmacie, mention Bien\nMaster en marketing pharmaceutique\nExpérience professionnelle\n2018 - 2022 Délégué médical\n2022 - présent Chef de produit\nLangues : français, anglais`,
  },
  {
    attendu: "COURRIER", pourquoi: "une lettre qui demande les bulletins de paie",
    nom: "courrier_banque.pdf",
    texte: `Alger, le 03/10/2026\nObjet : dossier de crédit\nMadame,\nMerci de joindre à votre dossier vos trois derniers bulletins de paie et une attestation de travail.\nVeuillez agréer, Madame, nos salutations distinguées.`,
  },
  {
    attendu: "BILLET_TRANSPORT", pourquoi: "un billet qui mentionne le passeport et l'hôtel",
    nom: "itinerary.pdf",
    texte: `E-TICKET RECEIPT\nTicket number: 124-2156789013\nFlight AH 1004 ALG – ORY\nDeparture 08:30 Arrival 11:00\nPassport number required at check-in. Transfer to hotel not included.`,
  },
  {
    attendu: "DEVIS", pourquoi: "un devis dont l'en-tête porte « Registre du commerce : … »",
    nom: "devis_traiteur.pdf",
    texte: `TRAITEUR EL BARAKA SARL\nRegistre du commerce : 16/00-7654321B20\nForme juridique : SARL – Capital social : 500 000 DA – Siège social : Blida\nDEVIS N° 2026-301\nPause café 120 personnes 96 000,00\nTotal HT 96 000,00\nOffre valable 15 jours`,
  },
  {
    attendu: "RESERVATION_HOTEL", pourquoi: "une réservation d'hôtel qui demande le numéro de passeport en tête",
    nom: "resa.pdf",
    texte: `Hotel Mercure Paris Centre\nPassport number: 198765432\nNationality: DZA\nBooking confirmation no. 77120\nCheck-in 11/11/2026 – Check-out 14/11/2026\n1 room, 3 nights`,
  },
  {
    attendu: "AUTRE", pourquoi: "une fiche voyageur qui demande les champs du passeport, sans en être un",
    nom: "fiche_voyageur.docx",
    texte: `Nom :\nPrénoms :\nN° de passeport :\nDate d'expiration :\nNationalité :\nLieu de naissance :`,
  },
  {
    attendu: "AUTRE", pourquoi: "un simple mot « facture » dans un message ne fait pas une facture",
    nom: "message.txt",
    texte: `Bonjour, je n'ai pas encore reçu la facture du traiteur. Peux-tu relancer ?`,
  },
];

describe("classerPiece — le corpus", () => {
  for (const cas of [...CORPUS, ...PIEGES]) {
    const titre = "pourquoi" in cas ? `piège : ${(cas as { pourquoi: string }).pourquoi}` : `${cas.attendu} — ${cas.nom}`;
    it(titre, () => {
      const r = classerPiece({ nomFichier: cas.nom, mime: cas.mime ?? "application/pdf", texte: cas.texte });
      expect(r.nature, r.indices.join(" | ")).toBe(cas.attendu);
    });
  }

  it("couvre chaque nature par au moins quatre pièces", () => {
    for (const n of NATURES_PIECE) expect(CORPUS.filter((x) => x.attendu === n).length, n).toBeGreaterThanOrEqual(4);
  });
});

describe("classerPiece — la confiance", () => {
  const tous = [...CORPUS, ...PIEGES].map((x) => classerPiece({ nomFichier: x.nom, mime: x.mime ?? "application/pdf", texte: x.texte }));

  it("ne dépasse 0,8 qu'avec deux indices concordants", () => {
    for (const r of tous) if (r.confiance > 0.8) expect(r.indices.filter((i) => !i.startsWith("proche de")).length).toBeGreaterThanOrEqual(2);
  });

  it("dit toujours ses indices, et « AUTRE » porte une confiance nulle", () => {
    for (const r of tous) {
      expect(r.indices.length).toBeGreaterThan(0);
      expect(r.confiance).toBeGreaterThanOrEqual(0);
      expect(r.confiance).toBeLessThanOrEqual(1);
      if (r.nature === "AUTRE") expect(r.confiance).toBe(0);
    }
  });

  it("un passeport à la MRZ cohérente est quasi certain ; un titre seul ne l'est pas", () => {
    const mrz = classerPiece({ nomFichier: "x.jpg", mime: "image/jpeg", texte: td3("DZA", "BENALI", "KARIM", "198765432", "840412", "M", "310915") });
    expect(mrz.nature).toBe("PASSEPORT");
    expect(mrz.confiance).toBeGreaterThanOrEqual(0.95);
    expect(mrz.indices).toContain("chiffres de contrôle MRZ cohérents");
    const seul = classerPiece({ nomFichier: "x.pdf", mime: "application/pdf", texte: "BULLETIN DE PAIE" });
    expect(seul.nature).toBe("BULLETIN_PAIE");
    expect(seul.confiance).toBeLessThanOrEqual(0.75);
  });

  it("une MRZ aux chiffres de contrôle faux reste un passeport, mais moins sûr", () => {
    const juste = td3("DZA", "BENALI", "KARIM", "198765432", "840412", "M", "310915");
    const faux = juste.slice(0, -1) + (juste.endsWith("0") ? "1" : "0");
    const lignes = faux.split("\n");
    lignes[1] = lignes[1]!.slice(0, 9) + ((Number(lignes[1]![9]) + 1) % 10) + lignes[1]!.slice(10);
    const r = classerPiece({ nomFichier: "x.jpg", mime: "image/jpeg", texte: lignes.join("\n") });
    expect(r.nature).toBe("PASSEPORT");
    expect(r.confiance).toBeLessThan(0.8);
    expect(r.indices).not.toContain("chiffres de contrôle MRZ cohérents");
  });

  it("le nom du fichier seul ne classe rien", () => {
    const r = classerPiece({ nomFichier: "passeport.pdf", mime: "application/pdf", texte: "Bonjour" });
    expect(r.nature).toBe("AUTRE");
    expect(r.indices.join(" ")).toMatch(/nom du fichier/);
  });

  it("deux natures à égalité : « AUTRE », et l'hésitation est dite", () => {
    const r = classerPiece({ nomFichier: "x.pdf", mime: "application/pdf", texte: "Entre les soussignés : A et B\nArticle 1 – objet" });
    expect(r.nature).toBe("AUTRE");
    expect(r.indices[0]).toMatch(/hésitation entre (contrat|convention) et (contrat|convention)/);
  });
});

describe("estNatureLocale", () => {
  it("rend vrai pour les pièces d'identité, la paie et le RIB — et seulement pour elles", () => {
    for (const n of NATURES_PIECE) expect(estNatureLocale(n)).toBe(NATURES_LOCALES.includes(n));
    expect(estNatureLocale("PASSEPORT")).toBe(true);
    expect(estNatureLocale("BULLETIN_PAIE")).toBe(true);
    expect(estNatureLocale("FACTURE")).toBe(false);
  });
});

describe("la matrice de confusion", () => {
  it("est diagonale sur le corpus et les pièges", () => {
    const matrice = new Map<string, number>();
    for (const x of [...CORPUS, ...PIEGES]) {
      const r = classerPiece({ nomFichier: x.nom, mime: x.mime ?? "application/pdf", texte: x.texte });
      if (process.env.MATRICE_CLASSEMENT) console.log(`${x.attendu.padEnd(30)} ${r.nature.padEnd(30)} ${r.confiance.toFixed(2)}  ${x.nom}  ${r.indices.join(" | ")}`);
      const cle = `${x.attendu} → ${r.nature}`;
      matrice.set(cle, (matrice.get(cle) ?? 0) + 1);
    }
    if (process.env.MATRICE_CLASSEMENT) console.log([...matrice.entries()].map(([k, v]) => `${k} : ${v}`).join("\n"));
    const erreurs = [...matrice.keys()].filter((k) => { const [a, b] = k.split(" → "); return a !== b; });
    expect(erreurs).toEqual([]);
  });
});
