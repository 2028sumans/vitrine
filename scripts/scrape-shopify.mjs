/**
 * Vitrine — Shopify product scraper
 * Scrapes womenswear Shopify stores and uploads products to Algolia.
 *
 * Run:
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs --domain majorelle.com
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs --dry-run
 */

import { algoliasearch } from "algoliasearch";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID  = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME      = "vitrine_products";
const BATCH_SIZE      = 500;
const CHECKPOINT_SIZE = 200;
const PAGE_DELAY_MS   = 600;
const CHECKPOINT_FILE = "scripts/shopify-checkpoint.json";
const LOG_FILE        = "scripts/shopify-scrape-log.txt";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const domainFlag  = args.includes("--domain") ? args[args.indexOf("--domain") + 1] : null;
const isDryRun    = args.includes("--dry-run");

// ── Brand domains ─────────────────────────────────────────────────────────────

const ALL_BRAND_DOMAINS = [
  // ── Vintage / resale (verified Shopify) ─────────────────────────────────
  { domain: "shrimptoncouture.com",    brand: "Shrimpton Couture" },
  { domain: "nostandingnyc.com",       brand: "No Standing NYC" },
  { domain: "ec.2ndstreetusa.com",     brand: "2nd Street USA" },
  { domain: "fashionphile.com",        brand: "Fashionphile" },
  // ── SSQRD brands (verified Shopify, full 619-brand list) ──────────────
  { domain: "4028.co.uk", brand: "4028" },
  { domain: "8rb4.com", brand: "8rb4" },
  { domain: "aroomlondon.com", brand: "A Room London" },
  { domain: "abe.store", brand: "Abe" },
  { domain: "abi-ame.com", brand: "Abi Amé" },
  { domain: "american-dreams.com", brand: "American Dreams" },
  { domain: "american-giant.com", brand: "American Giant" },
  { domain: "amrhea.com", brand: "Amrhea" },
  { domain: "annasui.com", brand: "Anna Sui" },
  { domain: "anniesibiza.com", brand: "Annie's Ibiza" },
  { domain: "antikbatik.com", brand: "Antik Batik" },
  { domain: "apparis.com", brand: "Apparis" },
  { domain: "apresstudio.com.au", brand: "Après Studio" },
  { domain: "archiesfootwear.com", brand: "Archies Footwear | Usa" },
  { domain: "arcinaori.com", brand: "Arcina Ori" },
  { domain: "arthurapparel.com", brand: "Arthur Apparel" },
  { domain: "atoir.com", brand: "Atoir" },
  { domain: "atyrstudio.com", brand: "Atyrstudio" },
  { domain: "autriquebrand.com", brand: "Autrique Brand" },
  { domain: "ava-be.com", brand: "Ava Be" },
  { domain: "awareofficial.com", brand: "Aware Official" },
  { domain: "azrathelabel.com", brand: "Azrathelabel" },
  { domain: "azva.co.uk", brand: "Azva" },
  { domain: "baobabstore.com", brand: "Baobab Store" },
  { domain: "baraqah.co.uk", brand: "Baraqah." },
  { domain: "batulthecollection.com", brand: "Batul The Collection" },
  { domain: "baumundpferdgarten.com", brand: "Baum Und Pferdgarten" },
  { domain: "bayabydesign.com", brand: "Bayabydesign" },
  { domain: "bearepark.com", brand: "Beare Park" },
  { domain: "belnu.com", brand: "Belnu" },
  { domain: "belski.com.au", brand: "Belski" },
  { domain: "berlinc.co", brand: "Berlinc" },
  { domain: "bhavyaramesh.com", brand: "Bhavya Ramesh" },
  { domain: "blondita.com", brand: "Blondita" },
  { domain: "bohemiabychlo.com", brand: "Bohemia By Chlo" },
  { domain: "brandonblackwood.com", brand: "Brandon Blackwood" },
  { domain: "bristowe.com.au", brand: "Bristowe" },
  { domain: "bubon.co", brand: "Bubon" },
  { domain: "bysalema.com", brand: "By Salema" },
  { domain: "by-zoya.com", brand: "By Zoya" },
  { domain: "byebambi.com", brand: "Bye Bambi" },
  { domain: "bymerrachi.com", brand: "Bymerrachi" },
  { domain: "byredo.co", brand: "Byredo" },
  { domain: "bysimran.com", brand: "Bysimran" },
  { domain: "caes-store.com", brand: "Caes Store" },
  { domain: "caia-kw.com", brand: "Caia Kw" },
  { domain: "camilactg.com", brand: "Camilactg" },
  { domain: "ceerinity.com", brand: "Ceerinity" },
  { domain: "chalay.store", brand: "Chalay" },
  { domain: "chanluu.com", brand: "Chan Luu" },
  { domain: "charlotteamelia.co", brand: "Charlotteamelia" },
  { domain: "cliopeppiatt.co.uk", brand: "Clio Peppiatt" },
  { domain: "cloimh.com", brand: "Cloimh" },
  { domain: "colomas.com", brand: "Colomas" },
  { domain: "contessamills.com", brand: "Contessa Mills" },
  { domain: "coramisa.com", brand: "Coramisa" },
  { domain: "coucouintimates.com", brand: "Cou Cou Intimates" },
  { domain: "cult-form.com", brand: "Cult Form" },
  { domain: "cultstore.com", brand: "Cultstore" },
  { domain: "cuyana.com", brand: "Cuyana" },
  { domain: "cybersweetie.co.uk", brand: "Cybersweetie" },
  { domain: "cyklar.com", brand: "Cyklar" },
  { domain: "damsonmadder.com", brand: "Damson Madder" },
  { domain: "datchoice.com", brand: "Dat'choice" },
  { domain: "daughtersofthesun.com", brand: "Daughters Of The Sun" },
  { domain: "delavali.com", brand: "De La Vali" },
  { domain: "dearrome.com.au", brand: "Dearrome" },
  { domain: "deijistudios.com", brand: "Deiji Studios" },
  { domain: "derschutze.com", brand: "Derschutze" },
  { domain: "dhruvkapoor.com", brand: "Dhruv Kapoor" },
  { domain: "diemattire.com", brand: "Diem Attire" },
  { domain: "dimaayad.com", brand: "Dima Ayad" },
  { domain: "dippindaisys.com", brand: "Dippin Daisys" },
  { domain: "dl1961.com", brand: "Dl1961" },
  { domain: "dlctcontemporary.com", brand: "Dlct Contemporary" },
  { domain: "dreamdressdelivered.com", brand: "Dream Dress Delivered" },
  { domain: "droc-jewelry.com", brand: "Droc Jewelry" },
  { domain: "ducie.co.uk", brand: "Ducie" },
  { domain: "eadem.co", brand: "Eadem" },
  { domain: "elinalinardaki.com", brand: "Elina Linardaki" },
  { domain: "eliou.com", brand: "Éliou" },
  { domain: "elissarrr.com", brand: "Elissarrr" },
  { domain: "ellamia.store", brand: "Ella Mia Store" },
  { domain: "elorea.com", brand: "Elorea" },
  { domain: "elywood.com", brand: "Elywood" },
  { domain: "emestudios.co", brand: "Eme Studios" },
  { domain: "eministore.com", brand: "Emini.store" },
  { domain: "enapelly.com", brand: "Ena Pelly" },
  { domain: "eshasoni.com", brand: "Esha Soni" },
  { domain: "esmenewyork.com", brand: "Esmé New York" },
  { domain: "faithfullthebrand.com", brand: "Faithfull The Brand" },
  { domain: "farsali.com", brand: "Farsali" },
  { domain: "felaci.com", brand: "Felaçi" },
  { domain: "findthara.com", brand: "Findthara" },
  { domain: "flore-flore.com", brand: "Flore Flore" },
  { domain: "folkloore.com", brand: "Folkloore" },
  { domain: "foryourviewingpleasure.co", brand: "For Your Viewing Pleasure" },
  { domain: "found.store", brand: "Found" },
  { domain: "fugazi.net", brand: "Fugazi" },
  { domain: "ghiaiacashmere.com", brand: "Ghiaia Cashmere" },
  { domain: "glamabayasss.com", brand: "Glamabayasss" },
  { domain: "glowrecipe.com", brand: "Glow Recipe" },
  { domain: "glucgator.com", brand: "Gluc-gator" },
  { domain: "goodrapport.nyc", brand: "Good Rapport" },
  { domain: "groverrad.com", brand: "Grover Rad" },
  { domain: "guestinresidence.com", brand: "Guest In Residence" },
  { domain: "hadiyatt.com", brand: "Hadiyatt" },
  { domain: "hanifa.co", brand: "Hanifa" },
  { domain: "heavenmayhem.com", brand: "Heaven Mayhem" },
  { domain: "henne.com.au", brand: "Henne" },
  { domain: "hermanoskoumori.com", brand: "Hermanos Koumori" },
  { domain: "hersonders.com", brand: "Hersonders" },
  { domain: "hertunba.com", brand: "Hertunba" },
  { domain: "high-sport.com", brand: "High Sport" },
  { domain: "hissaline.com", brand: "Hissa Line" },
  { domain: "hivepreloved.com", brand: "Hive Preloved" },
  { domain: "holichic.com", brand: "Holichic" },
  { domain: "hosbjerg.com", brand: "Hosbjerg" },
  { domain: "hue.com", brand: "Hue" },
  { domain: "huelleyrose.com", brand: "Huelleyrose" },
  { domain: "huongboutique.com", brand: "Huong Boutique" },
  { domain: "iamdelilah.com", brand: "I Am Delilah" },
  { domain: "ibekaofficial.com", brand: "Ibeka Official" },
  { domain: "igdalyah.com", brand: "Igdalyah" },
  { domain: "imnotamorningperson.store", brand: "Imnotamorningperson" },
  { domain: "inyourtwenties.com", brand: "In Your Twenties" },
  { domain: "indigoluna.store", brand: "Indigo Luna" },
  { domain: "inshou.store", brand: "Inshou" },
  { domain: "insis.shop", brand: "Insis" },
  { domain: "intogaia.co.uk", brand: "Into Gaia" },
  { domain: "issaturner.com", brand: "Issa Turner" },
  { domain: "jcthelabel.com", brand: "Jc The Label" },
  { domain: "jo-elle.co.uk", brand: "Jo Elle" },
  { domain: "johnstonsofelgin.com", brand: "Johnstons Of Elgin" },
  { domain: "junojane.co", brand: "Juno Jane" },
  { domain: "jwpei.com", brand: "Jw Pei" },
  { domain: "kandrlondon.com", brand: "K&r London" },
  { domain: "kadiwathelabel.com", brand: "Kadiwa The Label" },
  { domain: "kaicollective.com", brand: "Kai Collective" },
  { domain: "kajalnewyork.com", brand: "Kajal New York" },
  { domain: "kallmeyer.nyc", brand: "Kallmeyer" },
  { domain: "karlaidlaw.com", brand: "Karlaidlaw" },
  { domain: "kartikresearch.com", brand: "Kartik Research" },
  { domain: "kayali.com", brand: "Kayali" },
  { domain: "kendallmilesdesigns.com", brand: "Kendall Miles Designs" },
  { domain: "khanums.co", brand: "Khanum's" },
  { domain: "kilentar.com", brand: "Kilentar" },
  { domain: "kinadese.com", brand: "Kinadese" },
  { domain: "klaythelabel.com", brand: "Klaythelabel" },
  { domain: "kookai.com", brand: "Kookai" },
  { domain: "koredoko.com", brand: "Koredoko" },
  { domain: "kwameadusei.com", brand: "Kwameadusei" },
  { domain: "la-fam.com", brand: "La Fam" },
  { domain: "lalune.com", brand: "La Lune" },
  { domain: "lacdemure.com", brand: "Lac Demure" },
  { domain: "lagunaco.com.au", brand: "Laguna Co" },
  { domain: "lamajouni.com", brand: "Lamajouni" },
  { domain: "lamarie.com.au", brand: "Lamarie" },
  { domain: "lameeramoda.com", brand: "Lameeramoda" },
  { domain: "laruicci.com", brand: "Laruicci" },
  { domain: "lavantathelabel.com", brand: "Lavantathelabel" },
  { domain: "lenodo.com", brand: "Le Nodo" },
  { domain: "leset.com", brand: "Leset" },
  { domain: "linaia.shop", brand: "Linaīa" },
  { domain: "littleyarn.com.au", brand: "Little Yarn" },
  { domain: "loveandnostalgia.com", brand: "Love And Nostalgia" },
  { domain: "maemdisko.com", brand: "Maem Disko" },
  { domain: "maisoneli.com", brand: "Maison Eli" },
  { domain: "maisonessentiele.com", brand: "Maison Essentiele" },
  { domain: "manieredevoir.com", brand: "Manière De Voir" },
  { domain: "mann.shop", brand: "Mann" },
  { domain: "manuatelier.com", brand: "Manu Atelier" },
  { domain: "manukaglobal.co", brand: "Manuka Global" },
  { domain: "marmar-halim.com", brand: "Marmar Halim" },
  { domain: "marqthelabel.com", brand: "Marq The Label" },
  { domain: "marthathebrand.com", brand: "Martha The Brand" },
  { domain: "martinianoshoes.com", brand: "Martiniano Shoes" },
  { domain: "matethelabel.com", brand: "Mate The Label" },
  { domain: "mejimeji.co", brand: "Meji Meji" },
  { domain: "miavesper.com", brand: "Mia Vesper" },
  { domain: "minkadinklondon.com", brand: "Minka Dink London" },
  { domain: "mistystorage.com", brand: "Mistystorage" },
  { domain: "mkdtstudio.com", brand: "Mkdtstudio" },
  { domain: "mlouye.com", brand: "Mlouye" },
  { domain: "modemischiefstudios.com", brand: "Mode Mischief Studios" },
  { domain: "moderncitizen.com", brand: "Modern Citizen" },
  { domain: "modleta.com", brand: "Modleta" },
  { domain: "momotarojeans.com", brand: "Momotaro Jeans" },
  { domain: "monphell.com", brand: "Monphell" },
  { domain: "montsand.com", brand: "Montsand" },
  { domain: "moomoda.com", brand: "Moo Moda" },
  { domain: "mortonmac.com.au", brand: "Morton Mac" },
  { domain: "motherlandpk.com", brand: "Motherland pk" },
  { domain: "motherlandpk.com", brand: "Motherland Pk" },
  { domain: "motionalmuse.com", brand: "Motional Muse" },
  { domain: "muskanmumtaz.com", brand: "Muskan Mumtaz" },
  { domain: "muslimbreakfastclub.com", brand: "Muslim Breakfast Club" },
  { domain: "mutimer.co", brand: "Mutimer" },
  { domain: "nadibydani.com", brand: "Nadi By Dani" },
  { domain: "nayrstudio.com", brand: "Nayrstudio" },
  { domain: "needledust.com", brand: "Needledust" },
  { domain: "nefsfinds.com", brand: "Nefsfinds" },
  { domain: "niathomas.co", brand: "Nia Thomas" },
  { domain: "nicobar.com", brand: "Nicobar" },
  { domain: "niharikavivek.com", brand: "Niharika Vivek" },
  { domain: "nobodyschild.com", brand: "Nobody's Child" },
  { domain: "nordicpoetry.com", brand: "Nordic Poetry" },
  { domain: "nukra.co.uk", brand: "Nukra" },
  { domain: "nuulee.nyc", brand: "Nüülee" },
  { domain: "o-files.com", brand: "O. Files" },
  { domain: "odaje.com", brand: "Odaje" },
  { domain: "ohneproject.com", brand: "Ohne Project" },
  { domain: "olend.net", brand: "Ölend" },
  { domain: "olgajoan.co", brand: "Olga Joan" },
  { domain: "olympialetan.com", brand: "Olympia Le-tan® (olt)" },
  { domain: "onemilethelabel.com", brand: "One Mile The Label" },
  { domain: "oneractive.com", brand: "Oner Active" },
  { domain: "orebella.com", brand: "Orebella" },
  { domain: "othernormal.co", brand: "Othernormal" },
  { domain: "ouithepeople.com", brand: "Oui The People" },
  { domain: "pace-shoes.com", brand: "Pace Shoes" },
  { domain: "pact.com", brand: "Pact" },
  { domain: "papilav.com", brand: "Papilav" },
  { domain: "par-moi.com", brand: "Par Moi" },
  { domain: "patriastudios.com", brand: "Patria Studios" },
  { domain: "paulamendoza.com", brand: "Paula Mendoza" },
  { domain: "peachyden.co.uk", brand: "Peachy Den" },
  { domain: "personsoul.com", brand: "Personsoul" },
  { domain: "philippa1970.com", brand: "Philippa 1970" },
  { domain: "pixiemarket.com", brand: "Pixie Market" },
  { domain: "politesociety.com", brand: "Polite Society" },
  { domain: "portervintage.com", brand: "Porter Vintage" },
  { domain: "postsole.com", brand: "Post Sole Studio" },
  { domain: "primallypure.com", brand: "Primally Pure" },
  { domain: "princssclub.com", brand: "Princssclub" },
  { domain: "prod.net", brand: "Prod" },
  { domain: "qipology.com", brand: "Qipology" },
  { domain: "quirimbasstudio.com", brand: "Quirimbas Studio®" },
  { domain: "r13.com", brand: "R13" },
  { domain: "raboesy.com", brand: "Raboesy" },
  { domain: "ragamalak.com", brand: "Raga Malak" },
  { domain: "ranacoatelier.com", brand: "Ranacoatelier" },
  { domain: "rastah.co", brand: "Rastah" },
  { domain: "ratboi.com", brand: "Rat Boi" },
  { domain: "rideinc.store", brand: "Rideinc.store" },
  { domain: "rockfishweatherwear.co.uk", brand: "Rockfish Weatherwear" },
  { domain: "romontio.com", brand: "Romontio" },
  { domain: "rubies.com", brand: "Rubies" },
  { domain: "ruby.co.uk", brand: "Ruby" },
  { domain: "rubyyazmin.com", brand: "Ruby Yazmin" },
  { domain: "ruesophie.com", brand: "Rue Sophie" },
  { domain: "saboskirt.com", brand: "Sabo Skirt" },
  { domain: "saboastudios.com", brand: "Saboa Studios" },
  { domain: "sacdecoratif.com", brand: "Sac Décoratif" },
  { domain: "saintvenust.com", brand: "Saint Venust" },
  { domain: "salaamcollection.com", brand: "Salaamcollection" },
  { domain: "samuelzelig.com", brand: "Samuel Zelig" },
  { domain: "sanea.store", brand: "Sanea" },
  { domain: "sansfaff.com", brand: "Sans Faff" },
  { domain: "santosbymonica.com", brand: "Santos By Monica" },
  { domain: "sarahsbag.com", brand: "Sarahsbag" },
  { domain: "sarelly.com", brand: "Sarelly" },
  { domain: "sashatherese.com", brand: "Sasha Therese" },
  { domain: "scarletandsam.com", brand: "Scarlet & Sam" },
  { domain: "seeingdouble.store", brand: "Seeing Double" },
  { domain: "sergebasics.com", brand: "Sergé Basics" },
  { domain: "setaye.com", brand: "Setaye" },
  { domain: "sheecvintage.com", brand: "Sheec Vintage" },
  { domain: "shop-peche.com", brand: "Shop Pêche" },
  { domain: "shopshashi.com", brand: "Shop Shashi" },
  { domain: "shopsolani.com", brand: "Shop Solani" },
  { domain: "significantother.shop", brand: "Significant Other" },
  { domain: "sisterstudios.com.au", brand: "Sister Studios" },
  { domain: "sistersandseekers.com", brand: "Sisters and Seekers" },
  { domain: "sistrsthelabel.co.uk", brand: "Sistrs The Label" },
  { domain: "sodopeclub.com", brand: "So Dópe Club" },
  { domain: "solamusa.com", brand: "Solamusa" },
  { domain: "solosefc.com", brand: "Solosé Fc" },
  { domain: "somebodee.com", brand: "Somebodée" },
  { domain: "songmont.com", brand: "Songmont" },
  { domain: "stinegoya.com", brand: "Stine Goya" },
  { domain: "storymfg.com", brand: "Story Mfg." },
  { domain: "studioseven.store", brand: "Studio Seven" },
  { domain: "studiozsj.com", brand: "Studio Zsj" },
  { domain: "summeraway.com", brand: "Summer Away" },
  { domain: "sundiaries.com.au", brand: "Sun Diaries" },
  { domain: "sunsetclubvintage.com", brand: "Sunset Club Vintage" },
  { domain: "susamusa.com", brand: "Susa Musa" },
  { domain: "svarini.com", brand: "Svarini" },
  { domain: "tae-park.com", brand: "Tae Park" },
  { domain: "tahbags.com", brand: "Tah Bags" },
  { domain: "taippe.com", brand: "Taippe" },
  { domain: "tallermarmoboutique.com", brand: "Taller Marmo Boutique" },
  { domain: "thehorse.co", brand: "The Horse" },
  { domain: "theinayah.com", brand: "The Inayah" },
  { domain: "thejodilife.com", brand: "The Jodi Life" },
  { domain: "thekismetreserve.com", brand: "The Kismet Reserve" },
  { domain: "themodiste.shop", brand: "The Modiste" },
  { domain: "theownstudio.com", brand: "The Own Studio" },
  { domain: "thevintagemarche.com", brand: "The Vintage Marché" },
  { domain: "the-are.com", brand: "The-are" },
  { domain: "thirdform.com", brand: "Thirdform" },
  { domain: "thuylam.co", brand: "Thuylâm" },
  { domain: "tosummer.shop", brand: "To Summer" },
  { domain: "toccin.com", brand: "Toccin" },
  { domain: "toujours.com.au", brand: "Toujours" },
  { domain: "tropicofvintage.com", brand: "Tropic Of Vintage" },
  { domain: "valdrinsahiti.com", brand: "Valdrin Sahiti" },
  { domain: "vanitarosa.com", brand: "Vanita Rosa" },
  { domain: "veiledcollection.com", brand: "Veiled Collection" },
  { domain: "velourgarments.com", brand: "Velour Garments" },
  { domain: "venderbys.com", brand: "Venderbys" },
  { domain: "vescartes.com", brand: "Vescartes" },
  { domain: "vincentboulevard.com", brand: "Vincentboulevard" },
  { domain: "vintagefootballshirts.com", brand: "Vintage Football Shirts" },
  { domain: "vivalstudios.com", brand: "Vival Studios" },
  { domain: "wandler.com", brand: "Wandler" },
  { domain: "wavey.shop", brand: "Wavey" },
  { domain: "weareelegance.co.uk", brand: "We Are Elegance" },
  { domain: "withconsideration.com.au", brand: "With Consideration" },
  { domain: "withharperlu.com", brand: "With Harper Lu" },
  { domain: "yayiperez.com", brand: "Yayi Perez" },
  { domain: "zayti.co", brand: "Zayti" },
  { domain: "zidouri.com", brand: "Zidouri" },
  // ── Contemporary / Revolve ecosystem ────────────────────────────────────
  { domain: "majorelle.com",           brand: "Majorelle" },
  { domain: "retrofete.com",           brand: "Retrofete" },
  { domain: "wayf.com",               brand: "WAYF" },
  { domain: "loverandfriends.com",     brand: "Lover and Friends" },
  { domain: "wearnbd.com",             brand: "NBD" },
  { domain: "shopmumu.com",            brand: "Mumu" },
  { domain: "lspaceswim.com",          brand: "L*Space" },
  { domain: "houseofharlow1960.com",   brand: "House of Harlow 1960" },
  { domain: "rails.com",              brand: "Rails" },
  { domain: "astrthelabel.com",        brand: "ASTR the Label" },
  { domain: "bardotfashion.com",       brand: "Bardot" },
  { domain: "significantotherlabel.com", brand: "Significant Other" },
  { domain: "forloveandlemons.com",    brand: "For Love & Lemons" },
  { domain: "farmrio.com",             brand: "Farm Rio" },
  { domain: "cultgaia.com",            brand: "Cult Gaia" },
  { domain: "lacademie.com",           brand: "L'Academie" },
  { domain: "staud.clothing",          brand: "STAUD" },
  { domain: "thesleeper.co",           brand: "The Sleeper" },
  { domain: "rotate1991.com",          brand: "Rotate" },
  { domain: "nanushka.com",            brand: "Nanushka" },
  { domain: "saylornyc.com",           brand: "Saylor" },
  { domain: "manningcartell.com",      brand: "Manning Cartell" },
  { domain: "ajeworld.com",            brand: "Aje" },
  { domain: "elliattonline.com",       brand: "elliatt" },
  { domain: "shonajoy.com",            brand: "Shona Joy" },
  { domain: "sir-thelabel.com",        brand: "Sir. The Label" },
  { domain: "becandbridge.com",        brand: "Bec + Bridge" },
  { domain: "finders-keepers.com",     brand: "Finders Keepers" },
  { domain: "theeastorder.com",        brand: "The East Order" },
  { domain: "atoir.com.au",            brand: "Atoir" },
  { domain: "hansenandgretel.com",     brand: "Hansen & Gretel" },
  { domain: "cleobella.com",           brand: "Cleobella" },
  { domain: "spelldesigns.com",        brand: "Spell" },
  { domain: "faithfulltbrand.com",     brand: "Faithfull the Brand" },
  { domain: "oakandfort.com",          brand: "Oak + Fort" },
  { domain: "wildfox.com",             brand: "Wildfox" },
  { domain: "tularosaclothing.com",    brand: "Tularosa" },
  { domain: "likelylabel.com",         brand: "Likely" },
  { domain: "caminycollection.com",    brand: "Caminy Collection" },
  { domain: "lalignenyc.com",          brand: "L'aligne" },
  { domain: "veronicam.com",           brand: "Veronica M" },
  { domain: "ronnykobo.com",           brand: "Ronny Kobo" },
  { domain: "byticket.com",            brand: "By Ticket" },
  { domain: "sabo-skirt.com",          brand: "Sabo Skirt" },
  { domain: "lulus.com",              brand: "Lulus" },
  { domain: "showpo.com",              brand: "Showpo" },
  { domain: "tigermist.com",           brand: "Tiger Mist" },
  { domain: "beginning-boutique.com",  brand: "Beginning Boutique" },
  { domain: "petal-and-pup.com",       brand: "Petal & Pup" },
  { domain: "iamgia.com",              brand: "I AM GIA" },
  { domain: "dissh.com",              brand: "Dissh" },
  { domain: "lioness-fashion.com",     brand: "Lioness" },
  { domain: "winona.com.au",           brand: "Winona" },
  { domain: "by-dyln.com",             brand: "By Dyln" },
  { domain: "johnnywas.com",           brand: "Johnny Was" },
  { domain: "rixo.co.uk",              brand: "RIXO" },
  { domain: "alicemccall.com.au",      brand: "Alice McCall" },
  { domain: "thurleyonline.com",       brand: "Thurley" },
  { domain: "realisation-par.com",     brand: "Realisation Par" },
  { domain: "loveshackfancy.com",      brand: "LoveShackFancy" },
  { domain: "aninebing.com",           brand: "Anine Bing" },
  { domain: "moussycollection.com",    brand: "Moussy" },
  { domain: "grlfrnd.com",             brand: "GRLFRND" },
  { domain: "agolde.com",              brand: "AGOLDE" },
  { domain: "currentelliott.com",      brand: "Current/Elliott" },
  { domain: "motherdenim.com",         brand: "Mother Denim" },
  { domain: "drdenim.com",             brand: "Dr Denim" },
  { domain: "nili-lotan.com",          brand: "Nili Lotan" },
  { domain: "jenni-kayne.com",         brand: "Jenni Kayne" },
  { domain: "hunza-g.com",             brand: "Hunza G" },
  { domain: "tropic-of-c.com",         brand: "Tropic of C" },
  { domain: "solid-and-striped.com",   brand: "Solid & Striped" },
  { domain: "tavik.com",              brand: "Tavik" },
  { domain: "mikohstore.com",          brand: "Miko H" },
  { domain: "cleobella.com",           brand: "Cleobella" },
  { domain: "ghost.co.uk",             brand: "Ghost" },
  { domain: "macgraw.com.au",          brand: "Macgraw" },
  { domain: "camilla.com",             brand: "Camilla" },
  { domain: "talulah.com.au",          brand: "Talulah" },
  { domain: "witchery.com",            brand: "Witchery" },
  { domain: "forever21.com",           brand: "Forever 21" },
  { domain: "paige.com",              brand: "Paige" },
  { domain: "seafolly.com",            brand: "Seafolly" },
  { domain: "ryanroche.com",           brand: "Ryan Roche" },
  { domain: "jet-swimwear.com.au",     brand: "Jets Swimwear" },
  // ── Sustainable / ethical / indie brands (verified Shopify, curated list) ──
  { domain: "3x1denim.com", brand: "3x1 Denim" },
  { domain: "7forallmankind.com", brand: "7 For All Mankind" },
  { domain: "a-cold-wall.com", brand: "A-COLD-WALL" },
  { domain: "academybrand.com", brand: "Academy Brand" },
  { domain: "aceandjig.com", brand: "Ace and Jig" },
  { domain: "adinareyter.com", brand: "Adina Reyter" },
  { domain: "agjeans.com", brand: "AG Jeans" },
  { domain: "aiayu.com", brand: "Aiayu" },
  { domain: "aimeleondore.com", brand: "Aime Leon Dore" },
  { domain: "ajeathletica.com", brand: "Aje Athletica" },
  { domain: "alala.store", brand: "Alala" },
  { domain: "albertaferretti.com", brand: "Alberta Ferretti" },
  { domain: "alexmill.com", brand: "Alex Mill" },
  { domain: "allbirds.com", brand: "Allbirds" },
  { domain: "alo-yoga.shop", brand: "Alo Yoga" },
  { domain: "anothertomorrow.co", brand: "Another Tomorrow" },
  { domain: "ariesarise.com", brand: "Aries Arise" },
  { domain: "armedangels.com", brand: "Armed Angels" },
  { domain: "asceno.com", brand: "Asceno" },
  { domain: "ayr.com", brand: "Ayr" },
  { domain: "aztechmountain.com", brand: "Aztech Mountain" },
  { domain: "byellowtail.com", brand: "B.YELLOWTAIL" },
  { domain: "badgleymischka.com", brand: "Badgley Mischka" },
  { domain: "banjanan.com", brand: "Banjanan" },
  { domain: "bassike.com", brand: "Bassike" },
  { domain: "beaumontorganic.com", brand: "Beaumont Organic" },
  { domain: "becandbridge.com.au", brand: "Bec and Bridge" },
  { domain: "beckettsimonon.com", brand: "Beckett Simonon" },
  { domain: "shopbeis.com", brand: "BEIS" },
  { domain: "beyondretro.com", brand: "Beyond Retro" },
  { domain: "beyondyoga.com", brand: "Beyond Yoga" },
  { domain: "bodenewyork.com", brand: "Bode New York" },
  { domain: "bondiborn.com", brand: "Bondi Born" },
  { domain: "brothervellies.com", brand: "Brother Vellies" },
  { domain: "byfar.com", brand: "By Far Store" },
  { domain: "camillaandmarc.com", brand: "Camilla and Marc" },
  { domain: "canadagoose.com.au", brand: "Canada Goose" },
  { domain: "carbon38.com", brand: "Carbon38" },
  { domain: "cawleystudio.com", brand: "Cawley Studio" },
  { domain: "ceciliebahnsen.com", brand: "Cecilie Bahnsen" },
  { domain: "cerihoover.com", brand: "Ceri Hoover" },
  { domain: "cherrylosangeles.com", brand: "Cherry Los Angeles" },
  { domain: "chiaraboni.com", brand: "Chiara Boni" },
  { domain: "childofwild.com", brand: "Child of Wild" },
  { domain: "chintiandparker.com", brand: "Chinti and Parker" },
  { domain: "christydawn.com", brand: "Christy Dawn" },
  { domain: "ciaolucia.com", brand: "Ciao Lucia" },
  { domain: "citizensofhumanity.com", brand: "Citizens of Humanity" },
  { domain: "clarev.com", brand: "Clare V" },
  { domain: "coclico.com", brand: "Coclico" },
  { domain: "collinastrada.com", brand: "Collina Strada" },
  { domain: "colorfulstandard.com", brand: "Colorful Standard" },
  { domain: "comme-des-garcons.com.au", brand: "Comme des Garcons" },
  { domain: "shopcurrentair.com", brand: "Current Air" },
  { domain: "dagnedover.com", brand: "Dagne Dover" },
  { domain: "deardenier.com", brand: "Dear Denier" },
  { domain: "dearfrances.com", brand: "Dear Frances" },
  { domain: "deijistudios.com.au", brand: "Deiji Studios" },
  { domain: "denimist.com", brand: "Denimist" },
  { domain: "designersremix.com", brand: "Designers Remix" },
  { domain: "shopdoen.com", brand: "Doen" },
  { domain: "driesvannoten.com", brand: "Dries Van Noten" },
  { domain: "ecoalf.com", brand: "Ecoalf" },
  { domain: "eighthgeneration.com", brand: "Eighth Generation" },
  { domain: "elkthelabel.com", brand: "Elk The Label" },
  { domain: "encircled.co", brand: "Encircled" },
  { domain: "envelope1976.com", brand: "Envelope1976" },
  { domain: "everlane.com", brand: "Everlane" },
  { domain: "feit.com", brand: "Feit" },
  { domain: "finisterre.com", brand: "Finisterre" },
  { domain: "fortela.com", brand: "Fortela" },
  { domain: "francesmay.com", brand: "Frances May" },
  { domain: "frankandoak.com", brand: "Frank and Oak" },
  { domain: "frankiesbikinis.com.au", brand: "Frankies Bikinis" },
  { domain: "fusalp.com", brand: "Fusalp" },
  { domain: "galvanlondon.com", brand: "Galvan London" },
  { domain: "gentlefawn.com", brand: "Gentle Fawn" },
  { domain: "girlfriend.com", brand: "Girlfriend" },
  { domain: "goldbergh.com", brand: "Goldbergh" },
  { domain: "gorjana.com", brand: "Gorjana" },
  { domain: "gorman.com.au", brand: "Gorman" },
  { domain: "groceriesapparel.com", brand: "Groceries Apparel" },
  { domain: "halfdays.com", brand: "Halfdays" },
  { domain: "harmonyparis.co", brand: "Harmony Paris" },
  { domain: "harvestandmill.com", brand: "Harvest and Mill" },
  { domain: "heronpreston.com", brand: "Heron Preston" },
  { domain: "hommegirls.com", brand: "HommeGirls" },
  { domain: "houseofsunny.com", brand: "House of Sunny" },
  { domain: "hyeinseo.com", brand: "Hyein Seo" },
  { domain: "ienki-ienki.com", brand: "Ienki Ienki" },
  { domain: "industryofallnations.com", brand: "Industry of All Nations" },
  { domain: "isabelmarant.com", brand: "Isabel Marant" },
  { domain: "isseymiyake.com", brand: "Issey Miyake" },
  { domain: "jacandjack.com", brand: "Jac and Jack" },
  { domain: "jackerwin.com", brand: "Jack Erwin" },
  { domain: "jennikayne.com", brand: "Jenni Kayne" },
  { domain: "jennypackham.com", brand: "Jenny Packham" },
  { domain: "jerome-dreyfuss.com", brand: "Jerome Dreyfuss" },
  { domain: "jnby.com.au", brand: "JNBY" },
  { domain: "joahbrown.com", brand: "Joah Brown" },
  { domain: "joesjeans.com", brand: "Joe's Jeans" },
  { domain: "johannaortiz.com", brand: "Johanna Ortiz" },
  { domain: "jungmaven.com", brand: "Jungmaven" },
  { domain: "jwanderson.com", brand: "JW Anderson" },
  { domain: "kalmanovich.net", brand: "Kalmanovich" },
  { domain: "khaite.com", brand: "Khaite" },
  { domain: "kingsofindigo.com", brand: "Kings of Indigo" },
  { domain: "kith.com", brand: "Kith" },
  { domain: "knowledgecottonapparel.com", brand: "Knowledge Cotton Apparel" },
  { domain: "komodo.co.uk", brand: "Komodo" },
  { domain: "kule.com", brand: "Kule" },
  { domain: "lanius.com", brand: "Lanius" },
  { domain: "lauralombardi.com", brand: "Laura Lombardi" },
  { domain: "laurenmanoogian.com", brand: "Lauren Manoogian" },
  { domain: "leemathews.com.au", brand: "Lee Mathews" },
  { domain: "lemlem.com", brand: "Lemlem" },
  { domain: "leset.shop", brand: "Leset" },
  { domain: "lindseythornburg.com", brand: "Lindsey Thornburg" },
  { domain: "lirikamatoshi.com", brand: "Lirika Matoshi" },
  { domain: "littleliffner.com", brand: "Little Liffner" },
  { domain: "livefashionable.com", brand: "Live Fashionable" },
  { domain: "loandsons.com", brand: "Lo and Sons" },
  { domain: "lorenstewart.com", brand: "Loren Stewart" },
  { domain: "loupcharmant.com", brand: "Loup Charmant" },
  { domain: "lovechild1979.com", brand: "Lovechild 1979" },
  { domain: "lucyandyak.com", brand: "Lucy and Yak" },
  { domain: "lunya.shop", brand: "Lunya" },
  { domain: "mgemi.com", brand: "M.Gemi" },
  { domain: "madsnorgaard.com", brand: "Mads Norgaard" },
  { domain: "mansurgavriel.com", brand: "Mansur Gavriel" },
  { domain: "marahoffman.com", brand: "Mara Hoffman" },
  { domain: "marchesa.com", brand: "Marchesa" },
  { domain: "margauxny.com", brand: "Margaux NY" },
  { domain: "marquesalmeida.com", brand: "Marques Almeida" },
  { domain: "mattandnat.com", brand: "Matt and Nat" },
  { domain: "mavi.shop", brand: "Mavi" },
  { domain: "maxhosa.com", brand: "MaXhosa" },
  { domain: "meliebianco.com", brand: "Melie Bianco" },
  { domain: "mirth.co", brand: "Mirth" },
  { domain: "mirthcaftans.com", brand: "Mirth Caftans" },
  { domain: "misalosangeles.com", brand: "Misa Los Angeles" },
  { domain: "missoma.com", brand: "Missoma" },
  { domain: "mondayswimwear.com.au", brand: "Monday Swimwear" },
  { domain: "moniquelhuillier.com", brand: "Monique Lhuillier" },
  { domain: "monkeegenes.com", brand: "Monkee Genes" },
  { domain: "moschino.com", brand: "Moschino" },
  { domain: "moshimoshimind.com", brand: "Moshi Moshi Mind" },
  { domain: "motherofpearl.com", brand: "Mother of Pearl" },
  { domain: "mudjeans.com", brand: "Mud Jeans" },
  { domain: "munthe.com", brand: "Munthe" },
  { domain: "naadam.co", brand: "Naadam" },
  { domain: "naeemkhan.com", brand: "Naeem Khan" },
  { domain: "natashazinko.com", brand: "Natasha Zinko" },
  { domain: "nililotan.com", brand: "Nili Lotan" },
  { domain: "ninetypercent.com", brand: "Ninety Percent" },
  { domain: "nisolo.com", brand: "Nisolo" },
  { domain: "nobis.com", brand: "Nobis" },
  { domain: "nobodydenim.com", brand: "Nobody Denim" },
  { domain: "nudea.shop", brand: "Nudea" },
  { domain: "nydj.com", brand: "NYDJ" },
  { domain: "theonia.com", brand: "Onia" },
  { domain: "theorendatribe.com", brand: "Orenda Tribe" },
  { domain: "oscardelarenta.com", brand: "Oscar de la Renta" },
  { domain: "oseiduro.com", brand: "Osei-Duro" },
  { domain: "outdoorvoices.com", brand: "Outdoor Voices" },
  { domain: "outerknown.com", brand: "Outerknown" },
  { domain: "outlanddenim.com", brand: "Outland Denim" },
  { domain: "pe-nation.com", brand: "P.E Nation" },
  { domain: "pamellaroland.com", brand: "Pamella Roland" },
  { domain: "paridesai.com", brand: "Pari Desai" },
  { domain: "parkerclay.com", brand: "Parker Clay" },
  { domain: "pasunemarque.com", brand: "Pas Une Marque" },
  { domain: "pinqponq.com", brand: "Pinqponq" },
  { domain: "prabalgurung.com", brand: "Prabal Gurung" },
  { domain: "theprada.shop", brand: "Prada" },
  { domain: "proenzaschouler.com", brand: "Proenza Schouler" },
  { domain: "pucci.com", brand: "Pucci" },
  { domain: "pyermoss.com", brand: "Pyer Moss" },
  { domain: "rachelcomey.com", brand: "Rachel Comey" },
  { domain: "rahyma.com", brand: "Rahyma" },
  { domain: "shopredone.com", brand: "Re/Done" },
  { domain: "rebeccavallance.com", brand: "Rebecca Vallance" },
  { domain: "reemacra.com", brand: "Reem Acra" },
  { domain: "rejinapyo.com", brand: "Rejina Pyo" },
  { domain: "richer-poorer.com", brand: "Richer Poorer" },
  { domain: "riley.com.au", brand: "Riley Studio" },
  { domain: "rodebjer.com", brand: "Rodebjer" },
  { domain: "rokit.co.uk", brand: "Rokit" },
  { domain: "roksanda.com", brand: "Roksanda" },
  { domain: "rolandmouret.com", brand: "Roland Mouret" },
  { domain: "rosieassoulin.com", brand: "Rosie Assoulin" },
  { domain: "rothys.com", brand: "Rothys" },
  { domain: "rouje.com", brand: "Rouje" },
  { domain: "ryan-roche.com", brand: "Ryan Roche" },
  { domain: "sabinamusayev.com", brand: "Sabina Musayev" },
  { domain: "sarahflint.com", brand: "Sarah Flint" },
  { domain: "scanlantheodore.com", brand: "Scanlan Theodore" },
  { domain: "sea-ny.com", brand: "Sea NY" },
  { domain: "secondfemale.com", brand: "Second Female" },
  { domain: "seekcollective.com", brand: "Seek Collective" },
  { domain: "self-portrait.com", brand: "Self Portrait" },
  { domain: "sheike.com", brand: "Sheike" },
  { domain: "shonajoy.com.au", brand: "Shona Joy" },
  { domain: "silviatcherassi.com", brand: "Silvia Tcherassi" },
  { domain: "simonerocha.com", brand: "Simone Rocha" },
  { domain: "sirthelabel.com", brand: "Sir The Label" },
  { domain: "sisterjane.com", brand: "Sister Jane" },
  { domain: "skinworldwide.com", brand: "Skin Worldwide" },
  { domain: "sophiebuhai.com", brand: "Sophie Buhai" },
  { domain: "sophieratner.com", brand: "Sophie Ratner" },
  { domain: "splits59.com", brand: "Splits59" },
  { domain: "st-agni.com", brand: "St. Agni" },
  { domain: "standardissue.store", brand: "Standard Issue" },
  { domain: "stoneandstrand.com", brand: "Stone and Strand" },
  { domain: "sweatybetty.com.au", brand: "Sweaty Betty" },
  { domain: "taftclothing.com", brand: "Taft Clothing" },
  { domain: "tecovas.com", brand: "Tecovas" },
  { domain: "tentree.com", brand: "Tentree" },
  { domain: "terijon.com", brand: "Teri Jon" },
  { domain: "thefrankieshop.com", brand: "The Frankie Shop" },
  { domain: "therow.com", brand: "The Row" },
  { domain: "thevintagetwin.com", brand: "The Vintage Twin" },
  { domain: "thinkingmu.com", brand: "Thinking Mu" },
  { domain: "thokkthokk.com", brand: "Thokk Thokk" },
  { domain: "thombrowne.com", brand: "Thom Browne" },
  { domain: "threads4thought.com", brand: "Threads 4 Thought" },
  { domain: "tigerlily.com", brand: "Tigerlily" },
  { domain: "toast.co.uk", brand: "Toast" },
  { domain: "tonle.com", brand: "Tonle" },
  { domain: "toteme-studio.com", brand: "Toteme Studio" },
  { domain: "tradlands.com", brand: "Tradlands" },
  { domain: "tuckshopco.com", brand: "Tuck Shop Co" },
  { domain: "twistedx.com", brand: "Twisted X" },
  { domain: "ullajohnson.com", brand: "Ulla Johnson" },
  { domain: "universalstandard.com", brand: "Universal Standard" },
  { domain: "varley.com", brand: "Varley" },
  { domain: "venroy.com", brand: "Venroy" },
  { domain: "viktoriaandwoods.com", brand: "Viktoria and Woods" },
  { domain: "whimsyandrow.com", brand: "Whimsy and Row" },
  { domain: "wiederhoeft.com", brand: "Wiederhoeft" },
  { domain: "wolfandshepherd.com", brand: "Wolf and Shepherd" },
  { domain: "wwake.com", brand: "Wwake" },
  { domain: "xirena.com", brand: "Xirena" },
  { domain: "yearofours.com", brand: "Year of Ours" },
  { domain: "shopzhivago.com", brand: "Zhivago" },
  // ── The Good Trade 99 list (verified Shopify) ──────────────────────────
  { domain: "theaday.com", brand: "ADAY" },
  { domain: "aliyawanek.com", brand: "Aliya Wanek" },
  { domain: "alohas.com", brand: "ALOHAS" },
  { domain: "armedangels.co.uk", brand: "ARMEDANGELS" },
  { domain: "beklina.com", brand: "Beklina" },
  { domain: "beyondretro.co.uk", brand: "Beyond Retro" },
  { domain: "bigbudpress.com", brand: "Big Bud Press" },
  { domain: "boden.com", brand: "Boden" },
  { domain: "coloredorganics.com", brand: "Colored Organics" },
  { domain: "colorfulstandard.co.uk", brand: "Colorful Standard" },
  { domain: "cotopaxi.com", brand: "Cotopaxi" },
  { domain: "coyuchi.com", brand: "Coyuchi" },
  { domain: "evewear.com", brand: "Evewear" },
  { domain: "gentleherd.com", brand: "Gentle Herd" },
  { domain: "hopeforflowers.com", brand: "Hope for Flowers" },
  { domain: "justblackdenim.com", brand: "Just Black Denim" },
  { domain: "kirrinfinch.com", brand: "Kirrin Finch" },
  { domain: "larelaxed.com", brand: "LA RELAXED" },
  { domain: "lisasaysgah.com", brand: "Lisa Says Gah" },
  { domain: "magiclinen.com", brand: "MagicLinen" },
  { domain: "matatraders.com", brand: "Mata Traders" },
  { domain: "michaelstars.com", brand: "Michael Stars" },
  { domain: "mightly.com", brand: "Mightly" },
  { domain: "mottandbow.com", brand: "Mott and Bow" },
  { domain: "nazeerah.com", brand: "Nazeerah" },
  { domain: "shopnoble.com", brand: "Noble" },
  { domain: "nooworks.com", brand: "Nooworks" },
  { domain: "ohsevendays.com", brand: "OhSevenDays" },
  { domain: "oliverlogan.com", brand: "Oliver Logan" },
  { domain: "organicbasics.com", brand: "Organic Basics" },
  { domain: "parksproject.us", brand: "Parks Project" },
  { domain: "patagonia.com.au", brand: "Patagonia" },
  { domain: "rujutasheth.com", brand: "Rujuta Sheth" },
  { domain: "savannahmorrow.com", brand: "Savannah Morrow" },
  { domain: "storq.com", brand: "Storq" },
  { domain: "summersalt.com", brand: "Summersalt" },
  { domain: "taylorstitch.com", brand: "Taylor Stitch" },
  { domain: "tentree.co.uk", brand: "tentree" },
  { domain: "theethicalsilkcompany.com", brand: "The Ethical Silk Company" },
  { domain: "thestandardstitch.com", brand: "The Standard Stitch" },
  { domain: "toadandco.com", brand: "Toad and Co" },
  { domain: "tomboyx.com", brand: "TomboyX" },
  { domain: "wawwa.co", brand: "WAWWA" },
  { domain: "whimsyandrow.us", brand: "Whimsy and Row" },
  { domain: "wildfang.com", brand: "Wildfang" },
  { domain: "shopxirena.com", brand: "Xirena" },
  { domain: "yesfriends.co", brand: "Yes Friends" },
];

// ── Utilities (same as upload-to-algolia.mjs) ─────────────────────────────────

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

function priceRange(price) {
  if (!price) return "unknown";
  if (price < 50)  return "budget";
  if (price < 150) return "mid";
  return "luxury";
}

const CATEGORY_KEYWORDS = {
  dress:   ["dress", "jumpsuit", "romper", "playsuit", "gown", "bodycon", "shift", "sundress", "minidress", "maxi dress", "midi dress"],
  top:     ["top", "blouse", "shirt", "tee", "tank", "cami", "camisole", "bodysuit", "sweater", "knit", "cardigan", "pullover", "sweatshirt", "hoodie", "corset", "crop"],
  bottom:  ["trouser", "pant", "skirt", "short", "jean", "denim", "legging", "culotte", "jogger", "wide-leg", "palazzo", "cargo"],
  jacket:  ["jacket", "blazer", "coat", "trench", "vest", "gilet", "puffer", "anorak", "cape", "overcoat", "bomber", "leather jacket"],
  shoes:   ["shoe", "boot", "sandal", "heel", "flat", "loafer", "sneaker", "mule", "pump", "stiletto", "wedge", "ankle boot", "ballet flat", "slingback"],
  bag:     ["bag", "tote", "clutch", "handbag", "purse", "backpack", "crossbody", "satchel", "pouch", "wristlet", "shoulder bag", "mini bag"],
};

function categorize(title) {
  const t = (title || "").toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return cat;
  }
  return "other";
}

const AESTHETIC_MAP = {
  minimalist:  ["minimal", "simple", "clean", "basic", "classic", "timeless", "structured", "tailored"],
  bohemian:    ["boho", "floral", "wrap", "maxi", "flowy", "linen", "crochet", "embroidered", "tiered", "peasant"],
  romantic:    ["lace", "ruffle", "frill", "satin", "silk", "floral", "tiered", "feminine", "bow", "ribbon", "corset"],
  edgy:        ["leather", "asymmetric", "cutout", "mesh", "chain", "bold", "moto", "grunge", "fishnet"],
  preppy:      ["plaid", "striped", "button", "collar", "polo", "tailored", "blazer", "nautical", "gingham"],
  casual:      ["jersey", "cotton", "relaxed", "oversized", "everyday", "comfort", "knit", "t-shirt"],
  elegant:     ["satin", "silk", "velvet", "drape", "formal", "evening", "gown", "ballgown", "sequin"],
  sporty:      ["active", "sport", "tennis", "athletic", "stretch", "performance", "biker"],
  cottagecore: ["floral", "ditsy", "prairie", "puff sleeve", "milkmaid", "embroidered", "gingham", "smocked"],
  party:       ["sequin", "glitter", "metallic", "mini", "bodycon", "cutout", "backless", "going out"],
  y2k:         ["low rise", "baby", "denim", "butterfly", "velour", "rhinestone", "micro", "crop"],
  coastal:     ["linen", "stripe", "nautical", "white", "blue", "breezy", "resort", "vacation", "sundress"],
};

const COLORS = ["black","white","red","blue","green","pink","yellow","orange","purple","brown",
  "beige","cream","navy","burgundy","olive","sage","terracotta","coral","mauve","lilac",
  "rust","camel","chocolate","ivory","gold","silver","leopard","floral","print"];

function tagAesthetics(text) {
  const t = (text || "").toLowerCase();
  const tags = [];
  for (const [aesthetic, kws] of Object.entries(AESTHETIC_MAP)) {
    if (kws.some((kw) => t.includes(kw))) tags.push(aesthetic);
  }
  for (const color of COLORS) {
    if (t.includes(color)) tags.push(color);
  }
  if (t.includes("mini")) tags.push("mini");
  if (t.includes("midi")) tags.push("midi");
  if (t.includes("maxi")) tags.push("maxi");
  return [...new Set(tags)];
}

// ── Mens filter ───────────────────────────────────────────────────────────────

const MENS_KEYWORDS = ["men", "mens", "man", "boys", "male", "unisex"];

function isMensProduct(product) {
  const title = (product.title || "").toLowerCase();
  const tags  = Array.isArray(product.tags)
    ? product.tags.map((t) => t.toLowerCase())
    : (typeof product.tags === "string" ? product.tags.toLowerCase().split(",").map((t) => t.trim()) : []);
  const productType = (product.product_type || "").toLowerCase();

  return MENS_KEYWORDS.some((kw) =>
    title.includes(kw) || productType.includes(kw) || tags.includes(kw)
  );
}

// ── Domain → safe objectID prefix ────────────────────────────────────────────

function domainToPrefix(domain) {
  return domain.replace(/\./g, "");
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { scrapedDomains: [], products: [] };
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return { scrapedDomains: [], products: [] };
  }
}

function saveCheckpoint(scrapedDomains, products) {
  try {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({ scrapedDomains, products }, null, 2));
  } catch (err) {
    log(`  WARN: Could not save checkpoint: ${err.message}`);
  }
}

// ── Page fetch ────────────────────────────────────────────────────────────────

async function fetchPage(domain, page) {
  const url = `https://${domain}/products.json?limit=250&page=${page}`;
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Vitrine/1.0; +https://vitrine.fashion)" },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const json = await res.json();
    return json.products ?? null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// ── Normalize product ─────────────────────────────────────────────────────────

function normalizeProduct(product, domain, brand) {
  const title = product.title || "";

  // Extract first valid image
  const images = (product.images || [])
    .map((img) => img.src || "")
    .filter((src) => src.startsWith("http") && src.length > 20);

  const image_url = images[0] ?? "";
  if (!image_url) return null;

  // Build product URL
  const handle = product.handle || "";
  if (!handle) return null;
  const product_url = `https://${domain}/products/${handle}`;

  // Price from first variant
  const variants = product.variants || [];
  const rawPrice = variants[0]?.price ?? product.price ?? null;
  const price = parsePrice(rawPrice);

  // Price range: products with variant prices spanning ranges — use first variant
  const allPrices = variants.map((v) => parsePrice(v.price)).filter((p) => p !== null);
  let price_range_val = priceRange(price);

  // Color: from option named "Color" or "Colour"
  const colorOption = (product.options || []).find(
    (o) => o.name?.toLowerCase() === "color" || o.name?.toLowerCase() === "colour"
  );
  const color = colorOption?.values?.[0] ?? "";

  // Material: from body_html or tags
  const description = (product.body_html || "").replace(/<[^>]+>/g, " ").slice(0, 500);

  const text = `${title} ${description} ${color} ${(product.tags || []).join(" ")}`;

  const objectID = `shpfy-${domainToPrefix(domain)}-${product.id}`;

  return {
    objectID,
    title,
    brand,
    price,
    price_range: price_range_val,
    color,
    material: "",
    description,
    image_url,
    images: images.slice(0, 5),
    product_url,
    retailer: brand,
    aesthetic_tags: tagAesthetics(text),
    category: categorize(title),
    scraped_at: new Date().toISOString(),
  };
}

// ── Scrape one domain ─────────────────────────────────────────────────────────

async function scrapeDomain(domain, brand, { dryRun = false } = {}) {
  log(`  Scraping ${domain} (${brand})…`);
  const products = [];
  let page = 1;

  while (true) {
    const raw = await fetchPage(domain, page);

    if (!raw) {
      if (page === 1) {
        log(`  SKIP ${domain}: fetch failed or non-Shopify response`);
      } else {
        log(`  ${domain}: page ${page} returned null, stopping`);
      }
      break;
    }

    if (raw.length === 0) {
      log(`  ${domain}: page ${page} empty, stopping (${products.length} total)`);
      break;
    }

    for (const rawProduct of raw) {
      // Skip mens products
      if (isMensProduct(rawProduct)) continue;

      const normalized = normalizeProduct(rawProduct, domain, brand);
      if (!normalized) continue;

      products.push(normalized);
    }

    log(`  ${domain}: page ${page} — ${raw.length} raw, ${products.length} kept`);

    if (dryRun) {
      log(`  DRY RUN: stopping after first page`);
      break;
    }

    if (raw.length < 250) break; // last page

    page++;
    // Polite delay
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return products;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY) {
    console.error("Missing ALGOLIA_APP_ID or ALGOLIA_ADMIN_KEY\n" +
      "Run: ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs");
    process.exit(1);
  }

  // Initialize log file
  try {
    appendFileSync(LOG_FILE, `\n===== Run started ${new Date().toISOString()} =====\n`);
  } catch {}

  // Determine which domains to scrape
  let brandDomains = ALL_BRAND_DOMAINS;

  if (domainFlag) {
    const match = ALL_BRAND_DOMAINS.find((b) => b.domain === domainFlag);
    if (!match) {
      // Allow ad-hoc domains not in the list
      brandDomains = [{ domain: domainFlag, brand: domainFlag }];
      log(`Domain ${domainFlag} not in known list — scraping with domain as brand name`);
    } else {
      brandDomains = [match];
    }
  } else if (isDryRun) {
    brandDomains = ALL_BRAND_DOMAINS.slice(0, 3);
    log("DRY RUN: only first 3 domains, first page only");
  }

  // Load checkpoint
  const checkpoint = loadCheckpoint();
  const scrapedDomains = new Set(checkpoint.scrapedDomains || []);
  let allProducts = checkpoint.products || [];

  if (scrapedDomains.size > 0) {
    log(`Resuming from checkpoint: ${scrapedDomains.size} domains already done, ${allProducts.length} products cached`);
  }

  // Scrape each domain
  let productsSinceLastCheckpoint = 0;

  for (const { domain, brand } of brandDomains) {
    if (scrapedDomains.has(domain)) {
      log(`SKIP ${domain}: already in checkpoint`);
      continue;
    }

    try {
      const domainProducts = await scrapeDomain(domain, brand, { dryRun: isDryRun });
      allProducts = allProducts.concat(domainProducts);
      scrapedDomains.add(domain);
      productsSinceLastCheckpoint += domainProducts.length;
      log(`  ${domain}: ${domainProducts.length} products (total: ${allProducts.length})`);

      // Save checkpoint every CHECKPOINT_SIZE products
      if (productsSinceLastCheckpoint >= CHECKPOINT_SIZE) {
        saveCheckpoint([...scrapedDomains], allProducts);
        log(`  Checkpoint saved (${allProducts.length} products, ${scrapedDomains.size} domains done)`);
        productsSinceLastCheckpoint = 0;
      }
    } catch (err) {
      log(`  ERROR ${domain}: ${err.message} — skipping`);
    }
  }

  // Final checkpoint
  saveCheckpoint([...scrapedDomains], allProducts);
  log(`\nAll domains scraped. Total products: ${allProducts.length}`);

  // Dedup by objectID
  const seen = new Set();
  const deduped = allProducts.filter((p) => {
    if (seen.has(p.objectID)) return false;
    seen.add(p.objectID);
    return true;
  });
  log(`After dedup: ${deduped.length} unique products`);

  // Upload to Algolia
  log("\nConnecting to Algolia…");
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  log(`Uploading in batches of ${BATCH_SIZE}…`);
  let uploaded = 0;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    try {
      await client.saveObjects({ indexName: INDEX_NAME, objects: batch });
      uploaded += batch.length;
      log(`  Uploaded ${uploaded}/${deduped.length}`);
    } catch (err) {
      log(`  ERROR uploading batch at ${i}: ${err.message}`);
    }
  }

  log(`\nDone! ${uploaded} products uploaded to "${INDEX_NAME}"`);

  // Breakdown by brand
  const counts = {};
  deduped.forEach((p) => { counts[p.brand] = (counts[p.brand] || 0) + 1; });
  log("\nBreakdown by brand:");
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([brand, count]) => log(`  ${brand}: ${count}`));
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
