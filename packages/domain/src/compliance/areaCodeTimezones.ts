/**
 * Best-effort NANP area code -> IANA time zone table, for TCPA calling-hours
 * enforcement (47 CFR 64.1200(a)(3): no calls before 8am or after 9pm in the
 * called party's local time). This is a heuristic, not a guarantee:
 *
 * - Several area codes straddle two time zones (e.g. FL 850, TX 915 vs 432,
 *   the KY/TN Eastern/Central splits); each is assigned to whichever zone
 *   covers the larger population, the same trade-off most commercial
 *   dialers make.
 * - Numbers ported across regions, VoIP numbers, and area codes not listed
 *   here (including all non-NANP/international numbers) have no known zone -
 *   callers using them are treated as unrestricted (see callingHours.ts)
 *   rather than blocked, since there's no legal-hours basis to block on.
 *
 * Extend this table as needed; it does not need to be exhaustive to be
 * useful, only to cover the area codes this deployment actually dials.
 */

const EASTERN_CODES = [
  "201", "202", "203", "207", "212", "215", "216", "220", "223", "224", "227", "234", "239", "240",
  "252", "267", "269", "272", "276", "301", "302", "304", "305", "313", "315", "317", "321", "330",
  "332", "336", "339", "347", "351", "352", "386", "401", "404", "407", "410", "412", "413", "419",
  "423", "434", "440", "443", "445", "463", "470", "475", "478", "484", "508", "513", "516", "517",
  "518", "540", "551", "561", "570", "571", "585", "586", "606", "607", "609", "610", "614", "616",
  "617", "631", "646", "678", "680", "689", "703", "704", "706", "716", "717", "718", "724", "727",
  "734", "740", "754", "757", "762", "770", "772", "774", "781", "786", "802", "803", "804", "813",
  "814", "839", "843", "845", "848", "850", "854", "856", "857", "859", "860", "862", "863", "864",
  "865", "878", "904", "906", "908", "910", "912", "914", "917", "919", "929", "934", "937", "941",
  "943", "947", "954", "959", "973", "978", "980", "984", "989",
];

const CENTRAL_CODES = [
  "205", "217", "218", "225", "228", "251", "254", "256", "260", "270", "281", "308", "309", "312",
  "314", "316", "318", "319", "320", "325", "331", "334", "337", "346", "361", "364", "402", "405",
  "409", "417", "430", "469", "479", "501", "502", "504", "507", "512", "515", "531", "534", "539",
  "563", "573", "574", "580", "601", "605", "608", "612", "615", "618", "620", "629", "630", "636",
  "641", "651", "660", "662", "682", "701", "708", "712", "713", "715", "731", "763", "769", "773",
  "779", "785", "806", "812", "815", "816", "817", "830", "832", "847", "870", "872", "901", "903",
  "913", "918", "920", "931", "936", "940", "952", "956", "972", "975", "979",
];

const MOUNTAIN_CODES = ["208", "303", "307", "385", "406", "435", "575", "719", "720", "801", "970"];

const PACIFIC_CODES = [
  "206", "209", "213", "253", "279", "310", "323", "341", "360", "408", "415", "424", "425", "442",
  "458", "503", "509", "510", "530", "541", "559", "562", "564", "619", "626", "628", "650", "657",
  "661", "669", "702", "707", "714", "725", "747", "760", "775", "805", "818", "820", "831", "858",
  "909", "916", "925", "949", "951", "971",
];

// Arizona (except the Navajo Nation) does not observe DST; America/Phoenix
// encodes that correctly year-round, unlike America/Denver.
const ARIZONA_CODES = ["480", "520", "602", "623", "928"];

const ALASKA_CODES = ["907"];
const HAWAII_CODES = ["808"];

export const AREA_CODE_TIMEZONES: Record<string, string> = {};

for (const code of EASTERN_CODES) AREA_CODE_TIMEZONES[code] = "America/New_York";
for (const code of CENTRAL_CODES) AREA_CODE_TIMEZONES[code] = "America/Chicago";
for (const code of MOUNTAIN_CODES) AREA_CODE_TIMEZONES[code] = "America/Denver";
for (const code of PACIFIC_CODES) AREA_CODE_TIMEZONES[code] = "America/Los_Angeles";
for (const code of ARIZONA_CODES) AREA_CODE_TIMEZONES[code] = "America/Phoenix";
for (const code of ALASKA_CODES) AREA_CODE_TIMEZONES[code] = "America/Anchorage";
for (const code of HAWAII_CODES) AREA_CODE_TIMEZONES[code] = "Pacific/Honolulu";
