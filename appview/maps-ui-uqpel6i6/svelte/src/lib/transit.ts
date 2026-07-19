// Multi-modal transit routing — worldwide (embedded DB + Nominatim + Overpass + OSRM)

import {
  type JourneyLeg,
  type MultiModalJourney,
  haversineDistance,
  generateGreatCircleArc,
} from './navigation';

// ── World major railway stations ─────────────────────────────────────────────

interface StationEntry {
  name: string;
  lat: number;
  lng: number;
  lines: string[];
}

const WORLD_STATIONS: StationEntry[] = [
  // ─── Japan ───
  { name: '札幌駅', lat: 43.0687, lng: 141.3508, lines: ['JR函館本線'] },
  { name: '新千歳空港駅', lat: 42.7862, lng: 141.6806, lines: ['JR千歳線'] },
  { name: '旭川駅', lat: 43.7631, lng: 142.3581, lines: ['JR函館本線'] },
  { name: '函館駅', lat: 41.7739, lng: 140.7267, lines: ['JR函館本線'] },
  { name: '新函館北斗駅', lat: 41.9046, lng: 140.6487, lines: ['北海道新幹線'] },
  { name: '仙台駅', lat: 38.2601, lng: 140.8824, lines: ['東北新幹線'] },
  { name: '盛岡駅', lat: 39.7014, lng: 141.1366, lines: ['東北新幹線'] },
  { name: '秋田駅', lat: 39.7170, lng: 140.1266, lines: ['秋田新幹線'] },
  { name: '山形駅', lat: 38.2484, lng: 140.3283, lines: ['山形新幹線'] },
  { name: '福島駅', lat: 37.7543, lng: 140.4598, lines: ['東北新幹線'] },
  { name: '新青森駅', lat: 40.8244, lng: 140.6963, lines: ['東北新幹線'] },
  { name: '東京駅', lat: 35.6812, lng: 139.7671, lines: ['東海道新幹線', '東北新幹線', 'JR山手線'] },
  { name: '品川駅', lat: 35.6284, lng: 139.7388, lines: ['東海道新幹線', '京急'] },
  { name: '新宿駅', lat: 35.6896, lng: 139.7006, lines: ['JR山手線', '小田急', '京王'] },
  { name: '渋谷駅', lat: 35.6580, lng: 139.7016, lines: ['JR山手線', '東急東横線'] },
  { name: '池袋駅', lat: 35.7295, lng: 139.7109, lines: ['JR山手線', '東武東上線'] },
  { name: '上野駅', lat: 35.7141, lng: 139.7774, lines: ['東北新幹線', 'JR山手線'] },
  { name: '横浜駅', lat: 35.4660, lng: 139.6226, lines: ['JR東海道線', '東急東横線'] },
  { name: '大宮駅', lat: 35.9065, lng: 139.6237, lines: ['東北新幹線', '上越新幹線', '北陸新幹線'] },
  { name: '千葉駅', lat: 35.6131, lng: 140.1135, lines: ['JR総武線'] },
  { name: '高崎駅', lat: 36.3224, lng: 139.0107, lines: ['上越新幹線', '北陸新幹線'] },
  { name: '宇都宮駅', lat: 36.5593, lng: 139.8982, lines: ['東北新幹線'] },
  { name: '名古屋駅', lat: 35.1706, lng: 136.8816, lines: ['東海道新幹線', '名鉄', '近鉄'] },
  { name: '静岡駅', lat: 34.9717, lng: 138.3892, lines: ['東海道新幹線'] },
  { name: '新潟駅', lat: 37.9108, lng: 139.0624, lines: ['上越新幹線'] },
  { name: '長野駅', lat: 36.6432, lng: 138.1886, lines: ['北陸新幹線'] },
  { name: '金沢駅', lat: 36.5781, lng: 136.6479, lines: ['北陸新幹線'] },
  { name: '富山駅', lat: 36.7016, lng: 137.2138, lines: ['北陸新幹線'] },
  { name: '新大阪駅', lat: 34.7334, lng: 135.5001, lines: ['東海道新幹線', '山陽新幹線'] },
  { name: '大阪駅', lat: 34.7024, lng: 135.4959, lines: ['JR東海道線', 'JR大阪環状線'] },
  { name: '京都駅', lat: 34.9858, lng: 135.7588, lines: ['東海道新幹線', '近鉄'] },
  { name: '新神戸駅', lat: 34.7044, lng: 135.1976, lines: ['山陽新幹線'] },
  { name: '岡山駅', lat: 34.6655, lng: 133.9185, lines: ['山陽新幹線'] },
  { name: '広島駅', lat: 34.3978, lng: 132.4753, lines: ['山陽新幹線'] },
  { name: '新山口駅', lat: 34.0866, lng: 131.4547, lines: ['山陽新幹線'] },
  { name: '高松駅', lat: 34.3508, lng: 134.0467, lines: ['JR予讃線'] },
  { name: '松山駅', lat: 33.8383, lng: 132.7519, lines: ['JR予讃線'] },
  { name: '博多駅', lat: 33.5898, lng: 130.4207, lines: ['山陽新幹線', '九州新幹線'] },
  { name: '小倉駅', lat: 33.8864, lng: 130.8829, lines: ['山陽新幹線'] },
  { name: '熊本駅', lat: 32.7900, lng: 130.6864, lines: ['九州新幹線'] },
  { name: '鹿児島中央駅', lat: 31.5842, lng: 130.5414, lines: ['九州新幹線'] },
  { name: '長崎駅', lat: 32.7520, lng: 129.8697, lines: ['西九州新幹線'] },
  { name: '那覇空港駅', lat: 26.2073, lng: 127.6507, lines: ['沖縄モノレール'] },
  // ─── South Korea ───
  { name: 'Seoul Station', lat: 37.5547, lng: 126.9707, lines: ['KTX', 'Seoul Metro Line 1'] },
  { name: 'Busan Station', lat: 35.1152, lng: 129.0404, lines: ['KTX', 'Busan Metro'] },
  { name: 'Gangnam Station', lat: 37.4979, lng: 127.0276, lines: ['Seoul Metro Line 2'] },
  { name: 'Incheon Station', lat: 37.4762, lng: 126.6173, lines: ['Seoul Metro Line 1'] },
  { name: 'Daejeon Station', lat: 36.3326, lng: 127.4343, lines: ['KTX'] },
  { name: 'Daegu Station', lat: 35.8798, lng: 128.6254, lines: ['KTX'] },
  { name: 'Gwangju Songjeong', lat: 35.1374, lng: 126.7913, lines: ['KTX'] },
  // ─── China ───
  { name: 'Beijing South', lat: 39.8652, lng: 116.3784, lines: ['Beijing–Shanghai HSR', 'Beijing–Tianjin ICR'] },
  { name: 'Beijing West', lat: 39.8948, lng: 116.3220, lines: ['Beijing–Guangzhou HSR'] },
  { name: 'Shanghai Hongqiao', lat: 31.1947, lng: 121.3215, lines: ['Beijing–Shanghai HSR', 'Shanghai Metro'] },
  { name: 'Shanghai Station', lat: 31.2494, lng: 121.4559, lines: ['Shanghai Metro'] },
  { name: 'Guangzhou South', lat: 22.9900, lng: 113.2682, lines: ['Wuhan–Guangzhou HSR'] },
  { name: 'Shenzhen North', lat: 22.6093, lng: 114.0308, lines: ['Guangzhou–Shenzhen HSR'] },
  { name: 'Chengdu East', lat: 30.6318, lng: 104.1534, lines: ['Chengdu–Chongqing HSR'] },
  { name: 'Wuhan Station', lat: 30.6116, lng: 114.4211, lines: ['Wuhan–Guangzhou HSR'] },
  { name: 'Hangzhou East', lat: 30.2905, lng: 120.2133, lines: ['Shanghai–Hangzhou HSR'] },
  { name: 'Nanjing South', lat: 31.9716, lng: 118.8032, lines: ['Beijing–Shanghai HSR'] },
  { name: 'Chongqing North', lat: 29.5876, lng: 106.5515, lines: ['Chengdu–Chongqing HSR'] },
  { name: 'Xi\'an North', lat: 34.3744, lng: 108.9395, lines: ['Zhengzhou–Xi\'an HSR'] },
  { name: 'Hong Kong West Kowloon', lat: 22.3048, lng: 114.1620, lines: ['Guangzhou–Shenzhen–HK XRL'] },
  // ─── Taiwan ───
  { name: 'Taipei Main Station', lat: 25.0478, lng: 121.5170, lines: ['THSR', 'TRA', 'Taipei Metro'] },
  { name: 'Zuoying (Kaohsiung)', lat: 22.6868, lng: 120.3076, lines: ['THSR', 'TRA'] },
  { name: 'Taichung (HSR)', lat: 24.1119, lng: 120.6154, lines: ['THSR'] },
  { name: 'Tainan (HSR)', lat: 22.9250, lng: 120.2861, lines: ['THSR'] },
  // ─── Southeast Asia ───
  { name: 'Bangkok Krung Thep Aphiwat', lat: 13.8124, lng: 100.5132, lines: ['SRT Northern Line'] },
  { name: 'Hua Lamphong', lat: 13.7381, lng: 100.5171, lines: ['SRT', 'MRT'] },
  { name: 'Kuala Lumpur Sentral', lat: 3.1346, lng: 101.6862, lines: ['KTM', 'ETS', 'KLIA Ekspres'] },
  { name: 'Singapore MRT Raffles Place', lat: 1.2836, lng: 103.8516, lines: ['MRT North-South', 'East-West'] },
  { name: 'Tanjong Pagar (JB Sentral link)', lat: 1.2747, lng: 103.8430, lines: ['Thomson–East Coast Line'] },
  { name: 'Ho Chi Minh Saigon', lat: 10.7830, lng: 106.6798, lines: ['Vietnam Railways'] },
  { name: 'Hanoi Station', lat: 21.0246, lng: 105.8412, lines: ['Vietnam Railways'] },
  { name: 'Jakarta Gambir', lat: -6.1766, lng: 106.8308, lines: ['KAI'] },
  { name: 'Manila PNR Tutuban', lat: 14.6010, lng: 120.9741, lines: ['PNR'] },
  // ─── India ───
  { name: 'New Delhi', lat: 28.6428, lng: 77.2196, lines: ['Rajdhani Express', 'Delhi Metro'] },
  { name: 'Mumbai CST', lat: 18.9402, lng: 72.8356, lines: ['Central Railway', 'Mumbai Suburban'] },
  { name: 'Mumbai Central', lat: 18.9691, lng: 72.8197, lines: ['Western Railway'] },
  { name: 'Howrah Junction (Kolkata)', lat: 22.5839, lng: 88.3428, lines: ['Eastern Railway'] },
  { name: 'Chennai Central', lat: 13.0828, lng: 80.2757, lines: ['Southern Railway'] },
  { name: 'Bangalore City', lat: 12.9788, lng: 77.5712, lines: ['South Western Railway'] },
  { name: 'Ahmedabad Junction', lat: 23.0270, lng: 72.6006, lines: ['Western Railway', 'Mumbai–Ahmedabad HSR'] },
  // ─── UK ───
  { name: 'London King\'s Cross', lat: 51.5322, lng: -0.1240, lines: ['LNER', 'Thameslink'] },
  { name: 'London St Pancras', lat: 51.5313, lng: -0.1260, lines: ['Eurostar', 'HS1', 'Thameslink'] },
  { name: 'London Paddington', lat: 51.5162, lng: -0.1764, lines: ['GWR', 'Elizabeth Line'] },
  { name: 'London Euston', lat: 51.5284, lng: -0.1337, lines: ['Avanti West Coast'] },
  { name: 'London Victoria', lat: 51.4952, lng: -0.1439, lines: ['Southeastern', 'Gatwick Express'] },
  { name: 'London Waterloo', lat: 51.5036, lng: -0.1131, lines: ['South Western Railway'] },
  { name: 'London Liverpool Street', lat: 51.5179, lng: -0.0825, lines: ['Greater Anglia', 'Elizabeth Line'] },
  { name: 'Birmingham New Street', lat: 52.4778, lng: -1.9003, lines: ['Avanti West Coast', 'CrossCountry'] },
  { name: 'Manchester Piccadilly', lat: 53.4774, lng: -2.2309, lines: ['Avanti West Coast', 'TransPennine'] },
  { name: 'Edinburgh Waverley', lat: 55.9520, lng: -3.1895, lines: ['LNER', 'ScotRail'] },
  { name: 'Glasgow Central', lat: 55.8599, lng: -4.2578, lines: ['ScotRail', 'Avanti West Coast'] },
  { name: 'Leeds Station', lat: 53.7960, lng: -1.5489, lines: ['LNER', 'TransPennine'] },
  { name: 'Bristol Temple Meads', lat: 51.4497, lng: -2.5813, lines: ['GWR', 'CrossCountry'] },
  // ─── France ───
  { name: 'Paris Gare du Nord', lat: 48.8810, lng: 2.3553, lines: ['Eurostar', 'Thalys', 'TGV Nord'] },
  { name: 'Paris Gare de Lyon', lat: 48.8443, lng: 2.3734, lines: ['TGV Sud-Est', 'TGV Méditerranée'] },
  { name: 'Paris Gare Montparnasse', lat: 48.8413, lng: 2.3209, lines: ['TGV Atlantique'] },
  { name: 'Paris Gare de l\'Est', lat: 48.8764, lng: 2.3590, lines: ['TGV Est'] },
  { name: 'Paris Gare Saint-Lazare', lat: 48.8760, lng: 2.3250, lines: ['Normandie Express'] },
  { name: 'Lyon Part-Dieu', lat: 45.7606, lng: 4.8597, lines: ['TGV'] },
  { name: 'Marseille Saint-Charles', lat: 43.3025, lng: 5.3803, lines: ['TGV Méditerranée'] },
  { name: 'Lille Europe', lat: 50.6389, lng: 3.0759, lines: ['Eurostar', 'TGV Nord'] },
  { name: 'Bordeaux Saint-Jean', lat: 44.8258, lng: -0.5563, lines: ['TGV Atlantique'] },
  { name: 'Strasbourg', lat: 48.5850, lng: 7.7347, lines: ['TGV Est'] },
  // ─── Germany ───
  { name: 'Berlin Hauptbahnhof', lat: 52.5251, lng: 13.3694, lines: ['ICE', 'IC', 'S-Bahn'] },
  { name: 'München Hauptbahnhof', lat: 48.1408, lng: 11.5583, lines: ['ICE', 'IC', 'S-Bahn'] },
  { name: 'Frankfurt (Main) Hbf', lat: 50.1068, lng: 8.6627, lines: ['ICE', 'IC'] },
  { name: 'Hamburg Hauptbahnhof', lat: 53.5530, lng: 10.0069, lines: ['ICE', 'IC'] },
  { name: 'Köln Hauptbahnhof', lat: 50.9433, lng: 6.9586, lines: ['ICE', 'Thalys'] },
  { name: 'Stuttgart Hauptbahnhof', lat: 48.7840, lng: 9.1816, lines: ['ICE', 'IC'] },
  { name: 'Düsseldorf Hauptbahnhof', lat: 51.2196, lng: 6.7932, lines: ['ICE', 'IC'] },
  { name: 'Hannover Hauptbahnhof', lat: 52.3768, lng: 9.7413, lines: ['ICE', 'IC'] },
  { name: 'Nürnberg Hauptbahnhof', lat: 49.4464, lng: 11.0823, lines: ['ICE'] },
  { name: 'Leipzig Hauptbahnhof', lat: 51.3458, lng: 12.3818, lines: ['ICE', 'S-Bahn'] },
  // ─── Netherlands / Belgium / Switzerland / Austria ───
  { name: 'Amsterdam Centraal', lat: 52.3791, lng: 4.9003, lines: ['NS Intercity', 'Thalys', 'ICE'] },
  { name: 'Rotterdam Centraal', lat: 51.9244, lng: 4.4696, lines: ['NS Intercity', 'Thalys'] },
  { name: 'Bruxelles-Midi', lat: 50.8358, lng: 4.3365, lines: ['Eurostar', 'Thalys', 'TGV'] },
  { name: 'Antwerpen-Centraal', lat: 51.2172, lng: 4.4213, lines: ['NS International', 'NMBS'] },
  { name: 'Zürich HB', lat: 47.3782, lng: 8.5404, lines: ['SBB', 'ICE'] },
  { name: 'Bern', lat: 46.9488, lng: 7.4399, lines: ['SBB'] },
  { name: 'Genève-Cornavin', lat: 46.2100, lng: 6.1423, lines: ['SBB', 'TGV Lyria'] },
  { name: 'Basel SBB', lat: 47.5474, lng: 7.5897, lines: ['SBB', 'TGV', 'ICE'] },
  { name: 'Wien Hauptbahnhof', lat: 48.1859, lng: 16.3782, lines: ['ÖBB Railjet', 'ICE'] },
  { name: 'Salzburg Hauptbahnhof', lat: 47.8130, lng: 13.0457, lines: ['ÖBB Railjet'] },
  { name: 'Innsbruck Hauptbahnhof', lat: 47.2634, lng: 11.4010, lines: ['ÖBB Railjet'] },
  // ─── Italy / Spain / Portugal ───
  { name: 'Roma Termini', lat: 41.9010, lng: 12.5019, lines: ['Frecciarossa', 'Italo'] },
  { name: 'Milano Centrale', lat: 45.4864, lng: 9.2044, lines: ['Frecciarossa', 'Italo'] },
  { name: 'Firenze Santa Maria Novella', lat: 43.7764, lng: 11.2479, lines: ['Frecciarossa'] },
  { name: 'Venezia Santa Lucia', lat: 45.4410, lng: 12.3212, lines: ['Frecciarossa'] },
  { name: 'Napoli Centrale', lat: 40.8530, lng: 14.2722, lines: ['Frecciarossa'] },
  { name: 'Bologna Centrale', lat: 44.5057, lng: 11.3432, lines: ['Frecciarossa'] },
  { name: 'Madrid Atocha', lat: 40.4065, lng: -3.6909, lines: ['AVE', 'Cercanías'] },
  { name: 'Madrid Chamartín', lat: 40.4722, lng: -3.6827, lines: ['AVE', 'Cercanías'] },
  { name: 'Barcelona Sants', lat: 41.3793, lng: 2.1402, lines: ['AVE', 'Renfe'] },
  { name: 'Sevilla Santa Justa', lat: 37.3919, lng: -5.9765, lines: ['AVE'] },
  { name: 'Valencia Joaquín Sorolla', lat: 39.4651, lng: -0.3774, lines: ['AVE'] },
  { name: 'Lisboa Santa Apolónia', lat: 38.7143, lng: -9.1229, lines: ['CP', 'Alfa Pendular'] },
  { name: 'Lisboa Oriente', lat: 38.7679, lng: -9.0990, lines: ['CP', 'Alfa Pendular'] },
  { name: 'Porto São Bento', lat: 41.1457, lng: -8.6103, lines: ['CP'] },
  // ─── Scandinavia / Poland / Czech ───
  { name: 'Stockholm Central', lat: 59.3307, lng: 18.0585, lines: ['SJ', 'SL'] },
  { name: 'Malmö Central', lat: 55.6091, lng: 13.0005, lines: ['SJ', 'Öresundståg'] },
  { name: 'Göteborg Central', lat: 57.7089, lng: 11.9733, lines: ['SJ'] },
  { name: 'København H', lat: 55.6728, lng: 12.5643, lines: ['DSB', 'Öresundståg'] },
  { name: 'Oslo S', lat: 59.9109, lng: 10.7529, lines: ['Vy', 'Flytoget'] },
  { name: 'Helsinki Central', lat: 60.1717, lng: 24.9414, lines: ['VR'] },
  { name: 'Warszawa Centralna', lat: 52.2287, lng: 21.0032, lines: ['PKP Intercity'] },
  { name: 'Kraków Główny', lat: 50.0678, lng: 19.9477, lines: ['PKP Intercity'] },
  { name: 'Praha hlavní nádraží', lat: 50.0832, lng: 14.4350, lines: ['ČD', 'RegioJet'] },
  { name: 'Budapest Keleti', lat: 47.5004, lng: 19.0839, lines: ['MÁV', 'Railjet'] },
  // ─── Russia ───
  { name: 'Moskva Leningradskaya', lat: 55.7747, lng: 37.6553, lines: ['Sapsan'] },
  { name: 'Sankt-Peterburg Moskovskiy', lat: 59.9293, lng: 30.3623, lines: ['Sapsan'] },
  // ─── Turkey / Middle East ───
  { name: 'İstanbul Sirkeci', lat: 41.0151, lng: 28.9773, lines: ['Marmaray'] },
  { name: 'Ankara Garı', lat: 39.9361, lng: 32.8559, lines: ['YHT'] },
  { name: 'Dubai Metro Union', lat: 25.2694, lng: 55.2968, lines: ['Dubai Metro Red'] },
  // ─── North America ───
  { name: 'New York Penn Station', lat: 40.7506, lng: -73.9935, lines: ['Amtrak', 'NJ Transit', 'LIRR'] },
  { name: 'New York Grand Central', lat: 40.7527, lng: -73.9772, lines: ['Metro-North'] },
  { name: 'Washington Union Station', lat: 38.8973, lng: -77.0066, lines: ['Amtrak', 'MARC', 'VRE'] },
  { name: 'Chicago Union Station', lat: 41.8789, lng: -87.6400, lines: ['Amtrak', 'Metra'] },
  { name: 'Boston South Station', lat: 42.3519, lng: -71.0551, lines: ['Amtrak', 'MBTA'] },
  { name: 'Philadelphia 30th Street', lat: 39.9566, lng: -75.1819, lines: ['Amtrak', 'SEPTA'] },
  { name: 'Los Angeles Union Station', lat: 34.0561, lng: -118.2365, lines: ['Amtrak', 'Metrolink', 'LA Metro'] },
  { name: 'San Francisco 4th & King', lat: 37.7765, lng: -122.3942, lines: ['Caltrain'] },
  { name: 'Toronto Union Station', lat: 43.6453, lng: -79.3806, lines: ['VIA Rail', 'GO Transit', 'UP Express'] },
  { name: 'Montréal Gare Centrale', lat: 45.4989, lng: -73.5672, lines: ['VIA Rail', 'Exo'] },
  { name: 'Vancouver Pacific Central', lat: 49.2737, lng: -123.0980, lines: ['VIA Rail', 'Amtrak Cascades'] },
  // ─── Australia / NZ ───
  { name: 'Sydney Central', lat: -33.8832, lng: 151.2063, lines: ['Sydney Trains', 'NSW TrainLink'] },
  { name: 'Melbourne Flinders Street', lat: -37.8183, lng: 144.9671, lines: ['Metro Trains', 'V/Line'] },
  { name: 'Melbourne Southern Cross', lat: -37.8184, lng: 144.9527, lines: ['V/Line', 'The Overland'] },
  { name: 'Brisbane Central', lat: -27.4660, lng: 153.0257, lines: ['Queensland Rail'] },
  { name: 'Perth Station', lat: -31.9516, lng: 115.8603, lines: ['Transperth'] },
  { name: 'Auckland Britomart', lat: -36.8440, lng: 174.7682, lines: ['Auckland Transport'] },
  // ─── Africa ───
  { name: 'Cairo Ramses Station', lat: 30.0625, lng: 31.2466, lines: ['Egyptian National Railways'] },
  { name: 'Casablanca Voyageurs', lat: 33.5895, lng: -7.5893, lines: ['ONCF', 'Al Boraq'] },
  { name: 'Johannesburg Park Station', lat: -26.1968, lng: 28.0418, lines: ['Gautrain', 'Shosholoza'] },
  { name: 'Cape Town Station', lat: -33.9228, lng: 18.4256, lines: ['Metrorail'] },
  { name: 'Nairobi Terminus (SGR)', lat: -1.3181, lng: 36.8963, lines: ['Madaraka Express'] },
  { name: 'Dar es Salaam SGR', lat: -6.8100, lng: 39.2800, lines: ['SGR Tanzania'] },
  // ─── South America ───
  { name: 'Buenos Aires Retiro', lat: -34.5929, lng: -58.3756, lines: ['Trenes Argentinos'] },
  { name: 'São Paulo Luz', lat: -23.5347, lng: -46.6341, lines: ['CPTM', 'Metro'] },
  { name: 'Rio de Janeiro Central', lat: -22.9027, lng: -43.1735, lines: ['SuperVia'] },
  { name: 'Santiago Estación Central', lat: -33.4525, lng: -70.6802, lines: ['EFE', 'Metro'] },
  { name: 'Lima Estación Desamparados', lat: -12.0449, lng: -77.0284, lines: ['Ferrovías Central'] },
];

// ── World major airports ─────────────────────────────────────────────────────

interface AirportEntry { iata: string; name: string; nameEn: string; lat: number; lng: number }

const WORLD_AIRPORTS: AirportEntry[] = [
  // Japan
  { iata: 'NRT', name: '成田国際空港', nameEn: 'Narita', lat: 35.7647, lng: 140.3864 },
  { iata: 'HND', name: '羽田空港', nameEn: 'Haneda', lat: 35.5494, lng: 139.7798 },
  { iata: 'KIX', name: '関西国際空港', nameEn: 'Kansai', lat: 34.4347, lng: 135.2440 },
  { iata: 'ITM', name: '大阪国際空港', nameEn: 'Itami', lat: 34.7855, lng: 135.4380 },
  { iata: 'CTS', name: '新千歳空港', nameEn: 'New Chitose', lat: 42.7752, lng: 141.6926 },
  { iata: 'FUK', name: '福岡空港', nameEn: 'Fukuoka', lat: 33.5859, lng: 130.4511 },
  { iata: 'OKA', name: '那覇空港', nameEn: 'Naha', lat: 26.1958, lng: 127.6459 },
  { iata: 'NGO', name: '中部国際空港', nameEn: 'Chubu Centrair', lat: 34.8584, lng: 136.8125 },
  { iata: 'SDJ', name: '仙台空港', nameEn: 'Sendai', lat: 38.1397, lng: 140.9170 },
  { iata: 'HIJ', name: '広島空港', nameEn: 'Hiroshima', lat: 34.4361, lng: 132.9194 },
  { iata: 'KOJ', name: '鹿児島空港', nameEn: 'Kagoshima', lat: 31.8034, lng: 130.7195 },
  { iata: 'ISG', name: '石垣空港', nameEn: 'Ishigaki', lat: 24.3964, lng: 124.2450 },
  // East Asia
  { iata: 'ICN', name: '仁川国際空港', nameEn: 'Incheon', lat: 37.4602, lng: 126.4407 },
  { iata: 'GMP', name: '金浦国際空港', nameEn: 'Gimpo', lat: 37.5588, lng: 126.7906 },
  { iata: 'PUS', name: '金海国際空港', nameEn: 'Gimhae', lat: 35.1796, lng: 128.9382 },
  { iata: 'PEK', name: '北京首都国際空港', nameEn: 'Beijing Capital', lat: 40.0799, lng: 116.6031 },
  { iata: 'PKX', name: '北京大興国際空港', nameEn: 'Beijing Daxing', lat: 39.5098, lng: 116.4105 },
  { iata: 'PVG', name: '上海浦東国際空港', nameEn: 'Shanghai Pudong', lat: 31.1443, lng: 121.8083 },
  { iata: 'SHA', name: '上海虹橋国際空港', nameEn: 'Shanghai Hongqiao', lat: 31.1979, lng: 121.3363 },
  { iata: 'CAN', name: '広州白雲国際空港', nameEn: 'Guangzhou Baiyun', lat: 23.3924, lng: 113.2988 },
  { iata: 'SZX', name: '深圳宝安国際空港', nameEn: 'Shenzhen Bao\'an', lat: 22.6393, lng: 113.8107 },
  { iata: 'CTU', name: '成都天府国際空港', nameEn: 'Chengdu Tianfu', lat: 30.3193, lng: 104.4412 },
  { iata: 'HKG', name: '香港国際空港', nameEn: 'Hong Kong', lat: 22.3080, lng: 113.9185 },
  { iata: 'TPE', name: '台湾桃園国際空港', nameEn: 'Taiwan Taoyuan', lat: 25.0777, lng: 121.2327 },
  { iata: 'MFM', name: 'マカオ国際空港', nameEn: 'Macau', lat: 22.1496, lng: 113.5914 },
  { iata: 'ULN', name: 'チンギスハーン空港', nameEn: 'Chinggis Khaan', lat: 47.8431, lng: 106.7666 },
  // Southeast Asia
  { iata: 'SIN', name: 'チャンギ国際空港', nameEn: 'Singapore Changi', lat: 1.3502, lng: 103.9944 },
  { iata: 'BKK', name: 'スワンナプーム空港', nameEn: 'Suvarnabhumi', lat: 13.6900, lng: 100.7501 },
  { iata: 'DMK', name: 'ドンムアン空港', nameEn: 'Don Mueang', lat: 13.9126, lng: 100.6068 },
  { iata: 'KUL', name: 'クアラルンプール空港', nameEn: 'KLIA', lat: 2.7456, lng: 101.7099 },
  { iata: 'CGK', name: 'スカルノ・ハッタ空港', nameEn: 'Soekarno-Hatta', lat: -6.1256, lng: 106.6559 },
  { iata: 'MNL', name: 'ニノイ・アキノ空港', nameEn: 'Ninoy Aquino', lat: 14.5086, lng: 121.0197 },
  { iata: 'SGN', name: 'タンソンニャット空港', nameEn: 'Tan Son Nhat', lat: 10.8188, lng: 106.6520 },
  { iata: 'HAN', name: 'ノイバイ空港', nameEn: 'Noi Bai', lat: 21.2212, lng: 105.8071 },
  { iata: 'RGN', name: 'ヤンゴン空港', nameEn: 'Yangon', lat: 16.9073, lng: 96.1332 },
  { iata: 'REP', name: 'シェムリアップ空港', nameEn: 'Siem Reap', lat: 13.4107, lng: 103.8128 },
  { iata: 'DPS', name: 'ングラ・ライ空港', nameEn: 'Bali Ngurah Rai', lat: -8.7482, lng: 115.1671 },
  // South Asia
  { iata: 'DEL', name: 'インディラ・ガンディー空港', nameEn: 'Delhi Indira Gandhi', lat: 28.5562, lng: 77.1000 },
  { iata: 'BOM', name: 'ムンバイ空港', nameEn: 'Mumbai CSI', lat: 19.0896, lng: 72.8656 },
  { iata: 'BLR', name: 'ベンガルール空港', nameEn: 'Bengaluru Kempegowda', lat: 13.1986, lng: 77.7066 },
  { iata: 'MAA', name: 'チェンナイ空港', nameEn: 'Chennai', lat: 12.9941, lng: 80.1709 },
  { iata: 'CCU', name: 'コルカタ空港', nameEn: 'Kolkata Netaji Subhas', lat: 22.6547, lng: 88.4467 },
  { iata: 'CMB', name: 'コロンボ空港', nameEn: 'Bandaranaike', lat: 7.1808, lng: 79.8842 },
  { iata: 'DAC', name: 'ダッカ空港', nameEn: 'Hazrat Shahjalal', lat: 23.8432, lng: 90.3978 },
  { iata: 'KTM', name: 'カトマンズ空港', nameEn: 'Tribhuvan', lat: 27.6966, lng: 85.3591 },
  // Middle East
  { iata: 'DXB', name: 'ドバイ国際空港', nameEn: 'Dubai', lat: 25.2528, lng: 55.3644 },
  { iata: 'AUH', name: 'アブダビ空港', nameEn: 'Abu Dhabi', lat: 24.4330, lng: 54.6511 },
  { iata: 'DOH', name: 'ハマド国際空港', nameEn: 'Hamad (Doha)', lat: 25.2731, lng: 51.6081 },
  { iata: 'IST', name: 'イスタンブール空港', nameEn: 'Istanbul', lat: 41.2753, lng: 28.7519 },
  { iata: 'SAW', name: 'サビハ・ギョクチェン空港', nameEn: 'Sabiha Gökçen', lat: 40.8986, lng: 29.3092 },
  { iata: 'TLV', name: 'ベン・グリオン空港', nameEn: 'Ben Gurion', lat: 32.0114, lng: 34.8867 },
  { iata: 'RUH', name: 'リヤド空港', nameEn: 'King Khalid', lat: 24.9576, lng: 46.6988 },
  { iata: 'JED', name: 'ジッダ空港', nameEn: 'King Abdulaziz', lat: 21.6796, lng: 39.1565 },
  // Europe
  { iata: 'LHR', name: 'ロンドン・ヒースロー', nameEn: 'London Heathrow', lat: 51.4700, lng: -0.4543 },
  { iata: 'LGW', name: 'ロンドン・ガトウィック', nameEn: 'London Gatwick', lat: 51.1537, lng: -0.1821 },
  { iata: 'STN', name: 'ロンドン・スタンステッド', nameEn: 'London Stansted', lat: 51.8850, lng: 0.2350 },
  { iata: 'CDG', name: 'パリ・シャルル・ド・ゴール', nameEn: 'Paris CDG', lat: 49.0097, lng: 2.5479 },
  { iata: 'ORY', name: 'パリ・オルリー', nameEn: 'Paris Orly', lat: 48.7262, lng: 2.3652 },
  { iata: 'AMS', name: 'アムステルダム・スキポール', nameEn: 'Amsterdam Schiphol', lat: 52.3105, lng: 4.7683 },
  { iata: 'FRA', name: 'フランクフルト空港', nameEn: 'Frankfurt', lat: 50.0379, lng: 8.5622 },
  { iata: 'MUC', name: 'ミュンヘン空港', nameEn: 'Munich', lat: 48.3537, lng: 11.7750 },
  { iata: 'BER', name: 'ベルリン空港', nameEn: 'Berlin Brandenburg', lat: 52.3667, lng: 13.5033 },
  { iata: 'MAD', name: 'マドリード・バラハス', nameEn: 'Madrid Barajas', lat: 40.4983, lng: -3.5676 },
  { iata: 'BCN', name: 'バルセロナ空港', nameEn: 'Barcelona El Prat', lat: 41.2974, lng: 2.0833 },
  { iata: 'FCO', name: 'ローマ・フィウミチーノ', nameEn: 'Rome Fiumicino', lat: 41.8003, lng: 12.2389 },
  { iata: 'MXP', name: 'ミラノ・マルペンサ', nameEn: 'Milan Malpensa', lat: 45.6306, lng: 8.7281 },
  { iata: 'ZRH', name: 'チューリッヒ空港', nameEn: 'Zurich', lat: 47.4647, lng: 8.5492 },
  { iata: 'VIE', name: 'ウィーン空港', nameEn: 'Vienna', lat: 48.1103, lng: 16.5697 },
  { iata: 'CPH', name: 'コペンハーゲン空港', nameEn: 'Copenhagen', lat: 55.6180, lng: 12.6561 },
  { iata: 'ARN', name: 'ストックホルム・アーランダ', nameEn: 'Stockholm Arlanda', lat: 59.6519, lng: 17.9186 },
  { iata: 'OSL', name: 'オスロ空港', nameEn: 'Oslo Gardermoen', lat: 60.1939, lng: 11.1004 },
  { iata: 'HEL', name: 'ヘルシンキ空港', nameEn: 'Helsinki Vantaa', lat: 60.3172, lng: 24.9633 },
  { iata: 'WAW', name: 'ワルシャワ空港', nameEn: 'Warsaw Chopin', lat: 52.1657, lng: 20.9671 },
  { iata: 'PRG', name: 'プラハ空港', nameEn: 'Prague Václav Havel', lat: 50.1008, lng: 14.2632 },
  { iata: 'BUD', name: 'ブダペスト空港', nameEn: 'Budapest Liszt', lat: 47.4369, lng: 19.2556 },
  { iata: 'ATH', name: 'アテネ空港', nameEn: 'Athens Eleftherios', lat: 37.9364, lng: 23.9445 },
  { iata: 'LIS', name: 'リスボン空港', nameEn: 'Lisbon Humberto Delgado', lat: 38.7813, lng: -9.1359 },
  { iata: 'DUB', name: 'ダブリン空港', nameEn: 'Dublin', lat: 53.4264, lng: -6.2499 },
  { iata: 'EDI', name: 'エディンバラ空港', nameEn: 'Edinburgh', lat: 55.9500, lng: -3.3725 },
  { iata: 'SVO', name: 'モスクワ・シェレメーチエヴォ', nameEn: 'Moscow Sheremetyevo', lat: 55.9726, lng: 37.4146 },
  // North America
  { iata: 'JFK', name: 'ジョン・F・ケネディ空港', nameEn: 'New York JFK', lat: 40.6413, lng: -73.7781 },
  { iata: 'EWR', name: 'ニューアーク空港', nameEn: 'Newark Liberty', lat: 40.6895, lng: -74.1745 },
  { iata: 'LGA', name: 'ラガーディア空港', nameEn: 'LaGuardia', lat: 40.7769, lng: -73.8740 },
  { iata: 'LAX', name: 'ロサンゼルス空港', nameEn: 'Los Angeles', lat: 33.9416, lng: -118.4085 },
  { iata: 'SFO', name: 'サンフランシスコ空港', nameEn: 'San Francisco', lat: 37.6213, lng: -122.3790 },
  { iata: 'ORD', name: 'シカゴ・オヘア空港', nameEn: 'Chicago O\'Hare', lat: 41.9742, lng: -87.9073 },
  { iata: 'ATL', name: 'アトランタ空港', nameEn: 'Atlanta Hartsfield', lat: 33.6407, lng: -84.4277 },
  { iata: 'DFW', name: 'ダラス・フォートワース', nameEn: 'Dallas/Fort Worth', lat: 32.8998, lng: -97.0403 },
  { iata: 'DEN', name: 'デンバー空港', nameEn: 'Denver', lat: 39.8561, lng: -104.6737 },
  { iata: 'SEA', name: 'シアトル空港', nameEn: 'Seattle-Tacoma', lat: 47.4502, lng: -122.3088 },
  { iata: 'MIA', name: 'マイアミ空港', nameEn: 'Miami', lat: 25.7959, lng: -80.2870 },
  { iata: 'IAD', name: 'ワシントン・ダレス', nameEn: 'Washington Dulles', lat: 38.9531, lng: -77.4565 },
  { iata: 'BOS', name: 'ボストン空港', nameEn: 'Boston Logan', lat: 42.3656, lng: -71.0096 },
  { iata: 'YYZ', name: 'トロント・ピアソン', nameEn: 'Toronto Pearson', lat: 43.6777, lng: -79.6248 },
  { iata: 'YVR', name: 'バンクーバー空港', nameEn: 'Vancouver', lat: 49.1967, lng: -123.1815 },
  { iata: 'YUL', name: 'モントリオール空港', nameEn: 'Montréal Trudeau', lat: 45.4706, lng: -73.7408 },
  { iata: 'MEX', name: 'メキシコシティ空港', nameEn: 'Mexico City Benito Juárez', lat: 19.4363, lng: -99.0721 },
  { iata: 'CUN', name: 'カンクン空港', nameEn: 'Cancún', lat: 21.0365, lng: -86.8771 },
  // South America
  { iata: 'GRU', name: 'サンパウロ・グアルーリョス', nameEn: 'São Paulo Guarulhos', lat: -23.4356, lng: -46.4731 },
  { iata: 'GIG', name: 'リオデジャネイロ空港', nameEn: 'Rio Galeão', lat: -22.8100, lng: -43.2506 },
  { iata: 'EZE', name: 'ブエノスアイレス・エセイサ', nameEn: 'Buenos Aires Ezeiza', lat: -34.8222, lng: -58.5358 },
  { iata: 'SCL', name: 'サンティアゴ空港', nameEn: 'Santiago', lat: -33.3930, lng: -70.7858 },
  { iata: 'LIM', name: 'リマ空港', nameEn: 'Lima Jorge Chávez', lat: -12.0219, lng: -77.1143 },
  { iata: 'BOG', name: 'ボゴタ空港', nameEn: 'Bogotá El Dorado', lat: 4.7016, lng: -74.1469 },
  { iata: 'PTY', name: 'パナマシティ空港', nameEn: 'Panama Tocumen', lat: 9.0714, lng: -79.3835 },
  // Africa
  { iata: 'JNB', name: 'ヨハネスブルグ空港', nameEn: 'Johannesburg OR Tambo', lat: -26.1392, lng: 28.2460 },
  { iata: 'CPT', name: 'ケープタウン空港', nameEn: 'Cape Town', lat: -33.9649, lng: 18.6017 },
  { iata: 'NBO', name: 'ナイロビ空港', nameEn: 'Nairobi Jomo Kenyatta', lat: -1.3192, lng: 36.9278 },
  { iata: 'CAI', name: 'カイロ空港', nameEn: 'Cairo', lat: 30.1219, lng: 31.4056 },
  { iata: 'CMN', name: 'カサブランカ空港', nameEn: 'Casablanca Mohammed V', lat: 33.3675, lng: -7.5900 },
  { iata: 'ADD', name: 'アディスアベバ空港', nameEn: 'Addis Ababa Bole', lat: 8.9779, lng: 38.7993 },
  { iata: 'LOS', name: 'ラゴス空港', nameEn: 'Lagos Murtala Muhammed', lat: 6.5774, lng: 3.3212 },
  { iata: 'DAR', name: 'ダルエスサラーム空港', nameEn: 'Dar es Salaam Julius Nyerere', lat: -6.8781, lng: 39.2026 },
  // Oceania
  { iata: 'SYD', name: 'シドニー空港', nameEn: 'Sydney Kingsford Smith', lat: -33.9461, lng: 151.1772 },
  { iata: 'MEL', name: 'メルボルン空港', nameEn: 'Melbourne Tullamarine', lat: -37.6733, lng: 144.8433 },
  { iata: 'BNE', name: 'ブリスベン空港', nameEn: 'Brisbane', lat: -27.3842, lng: 153.1175 },
  { iata: 'AKL', name: 'オークランド空港', nameEn: 'Auckland', lat: -37.0082, lng: 174.7850 },
  { iata: 'PER', name: 'パース空港', nameEn: 'Perth', lat: -31.9403, lng: 115.9672 },
  { iata: 'NAN', name: 'ナンディ空港', nameEn: 'Nadi Fiji', lat: -17.7554, lng: 177.4431 },
];

// ── World major ferry ports ──────────────────────────────────────────────────

interface PortEntry { name: string; lat: number; lng: number }

const WORLD_FERRY_PORTS: PortEntry[] = [
  // Japan
  { name: '小樽港', lat: 43.1997, lng: 140.9945 },
  { name: '苫小牧港', lat: 42.6314, lng: 141.6167 },
  { name: '函館港', lat: 41.7773, lng: 140.7213 },
  { name: '青森港', lat: 40.8343, lng: 140.7482 },
  { name: '仙台港', lat: 38.2694, lng: 141.0250 },
  { name: '大洗港', lat: 36.3145, lng: 140.5758 },
  { name: '東京港(竹芝)', lat: 35.6505, lng: 139.7618 },
  { name: '新潟港', lat: 37.9432, lng: 139.0612 },
  { name: '名古屋港', lat: 35.0795, lng: 136.8815 },
  { name: '大阪南港', lat: 34.6286, lng: 135.4216 },
  { name: '神戸港', lat: 34.6706, lng: 135.1950 },
  { name: '広島港', lat: 34.3593, lng: 132.4659 },
  { name: '松山観光港', lat: 33.8873, lng: 132.7128 },
  { name: '高松港', lat: 34.3524, lng: 134.0504 },
  { name: '博多港', lat: 33.6067, lng: 130.3812 },
  { name: '鹿児島港', lat: 31.5891, lng: 130.5678 },
  { name: '那覇港', lat: 26.2147, lng: 127.6666 },
  { name: '屋久島(宮之浦港)', lat: 30.3850, lng: 130.5583 },
  { name: '種子島(西之表港)', lat: 30.7317, lng: 131.0000 },
  // East Asia
  { name: 'Busan International Ferry', lat: 35.1014, lng: 129.0359 },
  { name: 'Incheon Ferry Terminal', lat: 37.4504, lng: 126.5892 },
  { name: 'Shanghai Wusongkou', lat: 31.3937, lng: 121.5037 },
  { name: 'Tianjin Port', lat: 38.9860, lng: 117.7370 },
  { name: 'Dalian Port', lat: 38.8672, lng: 121.6503 },
  { name: 'Qingdao Port', lat: 36.0815, lng: 120.3165 },
  { name: 'Hong Kong — Macau Ferry', lat: 22.2892, lng: 114.1522 },
  { name: 'Keelung Port (Taiwan)', lat: 25.1554, lng: 121.7412 },
  // Southeast Asia
  { name: 'Singapore HarbourFront', lat: 1.2656, lng: 103.8197 },
  { name: 'Batam Centre Ferry', lat: 1.0631, lng: 104.0315 },
  { name: 'Penang — Butterworth Ferry', lat: 5.4045, lng: 100.3463 },
  { name: 'Langkawi Ferry', lat: 6.3165, lng: 99.8452 },
  { name: 'Manila (Port of Manila)', lat: 14.5879, lng: 120.9620 },
  { name: 'Bali Padang Bai', lat: -8.5356, lng: 115.5093 },
  { name: 'Phuket Rassada Pier', lat: 7.8591, lng: 98.3803 },
  // Europe — North Sea / Baltic
  { name: 'Dover Ferry Terminal', lat: 51.1279, lng: 1.3134 },
  { name: 'Calais Ferry Terminal', lat: 50.9690, lng: 1.8700 },
  { name: 'Harwich International', lat: 51.9444, lng: 1.2578 },
  { name: 'Hook of Holland', lat: 51.9810, lng: 4.1260 },
  { name: 'Holyhead Ferry', lat: 53.3098, lng: -4.6323 },
  { name: 'Dublin Ferryport', lat: 53.3483, lng: -6.2067 },
  { name: 'Rosslare Europort', lat: 52.2537, lng: -6.3398 },
  { name: 'IJmuiden (Amsterdam) Ferry', lat: 52.4596, lng: 4.5960 },
  { name: 'Newcastle Ferry', lat: 55.0077, lng: -1.4406 },
  { name: 'Copenhagen — Malmö', lat: 55.6907, lng: 12.5986 },
  { name: 'Helsinki West Terminal', lat: 60.1534, lng: 24.9206 },
  { name: 'Stockholm Värtahamnen', lat: 59.3509, lng: 18.1073 },
  { name: 'Tallinn D-Terminal', lat: 59.4474, lng: 24.7651 },
  { name: 'Turku Harbour', lat: 60.4354, lng: 22.2207 },
  { name: 'Gothenburg Stena Terminal', lat: 57.7116, lng: 11.9258 },
  { name: 'Kiel Ostseekai', lat: 54.3558, lng: 10.1477 },
  { name: 'Travemünde', lat: 53.9598, lng: 10.8633 },
  { name: 'Rostock Port', lat: 54.1464, lng: 12.0794 },
  // Europe — Mediterranean
  { name: 'Piraeus (Athens)', lat: 37.9476, lng: 23.6380 },
  { name: 'Barcelona Ferry Port', lat: 41.3641, lng: 2.1738 },
  { name: 'Civitavecchia (Rome)', lat: 42.0934, lng: 11.7886 },
  { name: 'Genova Ferry Terminal', lat: 44.4067, lng: 8.9204 },
  { name: 'Napoli Molo Beverello', lat: 40.8363, lng: 14.2532 },
  { name: 'Livorno Ferry', lat: 43.5508, lng: 10.2942 },
  { name: 'Palermo Port', lat: 38.1277, lng: 13.3613 },
  { name: 'Bari Ferry Terminal', lat: 41.1335, lng: 16.8619 },
  { name: 'Split Ferry Port', lat: 43.5074, lng: 16.4383 },
  { name: 'Dubrovnik Gruž', lat: 42.6588, lng: 18.0832 },
  { name: 'Patras Port', lat: 38.2480, lng: 21.7297 },
  { name: 'Heraklion Port (Crete)', lat: 35.3436, lng: 25.1518 },
  { name: 'Marseille Joliette', lat: 43.3028, lng: 5.3627 },
  { name: 'Tangier Med', lat: 35.8912, lng: -5.4961 },
  { name: 'Algeciras Port', lat: 36.1264, lng: -5.4413 },
  { name: 'İstanbul Yenikapı', lat: 41.0038, lng: 28.9530 },
  // North America
  { name: 'Seattle — Bainbridge Ferry', lat: 47.6025, lng: -122.3392 },
  { name: 'Vancouver Tsawwassen', lat: 49.0060, lng: -123.1319 },
  { name: 'Victoria Swartz Bay', lat: 48.6880, lng: -123.4098 },
  { name: 'New York Staten Island Ferry', lat: 40.6437, lng: -74.0713 },
  { name: 'Miami Port', lat: 25.7744, lng: -80.1730 },
  { name: 'Fort Lauderdale Port Everglades', lat: 26.0918, lng: -80.1109 },
  // Oceania
  { name: 'Sydney Circular Quay', lat: -33.8610, lng: 151.2108 },
  { name: 'Auckland Downtown Ferry', lat: -36.8429, lng: 174.7667 },
  { name: 'Wellington Interislander', lat: -41.2819, lng: 174.7820 },
  { name: 'Picton Ferry', lat: -41.2907, lng: 174.0014 },
  { name: 'Devonport Ferry (Melbourne)', lat: -41.1794, lng: 146.3564 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

interface OverpassNode {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

function unsupportedTransitApi(apiName: string): never {
  throw new Error(
    `${apiName} is not available: generated Connect descriptor/client for transit APIs was not found in this project (maps-ui-uqpel6i6).`,
  );
}

async function overpassQuery(query: string): Promise<any> {
  void query;
  return unsupportedTransitApi('Overpass');
}

async function nominatimStationSearch(
  lat: number,
  lng: number,
  radiusKm = 15,
  limit = 5,
): Promise<OverpassNode[]> {
  void lat;
  void lng;
  void radiusKm;
  void limit;
  return unsupportedTransitApi('Nominatim');
}

function findNearbyFromDB<T extends { lat: number; lng: number }>(
  db: T[],
  lat: number,
  lng: number,
  radiusKm: number,
  maxResults: number,
  toNode: (entry: T) => OverpassNode,
): OverpassNode[] {
  const results: Array<{ node: OverpassNode; dist: number }> = [];
  for (const entry of db) {
    const d = haversineDistance(lat, lng, entry.lat, entry.lng);
    if (d <= radiusKm * 1000) {
      results.push({ node: toNode(entry), dist: d });
    }
  }
  results.sort((a, b) => a.dist - b.dist);
  return results.slice(0, maxResults).map((r) => r.node);
}

function findNearbyStationsFromDB(lat: number, lng: number, radiusKm = 20, maxResults = 5): OverpassNode[] {
  return findNearbyFromDB(WORLD_STATIONS, lat, lng, radiusKm, maxResults, (s) => ({
    id: Math.round(s.lat * 10000 + s.lng * 100),
    lat: s.lat,
    lon: s.lng,
    tags: { name: s.name, lines: s.lines.join(', ') },
  }));
}

function findNearbyPortsFromDB(lat: number, lng: number, radiusKm = 50, maxResults = 3): OverpassNode[] {
  return findNearbyFromDB(WORLD_FERRY_PORTS, lat, lng, radiusKm, maxResults, (p) => ({
    id: Math.round(p.lat * 10000 + p.lng * 100),
    lat: p.lat,
    lon: p.lng,
    tags: { name: p.name },
  }));
}

async function findNearbyStations(lat: number, lng: number): Promise<OverpassNode[]> {
  // 1. Embedded DB (instant, reliable, worldwide coverage of major hubs)
  const dbResults = findNearbyStationsFromDB(lat, lng, 20, 5);
  if (dbResults.length > 0) return dbResults;

  // 2. Nominatim (global OSM search)
  const nomResults = await nominatimStationSearch(lat, lng, 25, 5);
  if (nomResults.length > 0) return nomResults;

  // 3. Overpass fallback (10km radius)
  try {
    const q = `[out:json][timeout:12];node["railway"="station"](around:10000,${lat},${lng});out body;`;
    const data = await overpassQuery(q);
    return (data.elements || []).filter((e: any) => e.type === 'node') as OverpassNode[];
  } catch { /* fall through */ }
  return [];
}

async function findNearbyFerryTerminals(lat: number, lng: number): Promise<OverpassNode[]> {
  // 1. Embedded DB
  const dbResults = findNearbyPortsFromDB(lat, lng, 50, 3);
  if (dbResults.length > 0) return dbResults;

  // 2. Overpass
  try {
    const q = `[out:json][timeout:12];(node["amenity"="ferryTerminal"](around:20000,${lat},${lng});node["ferry"="yes"](around:20000,${lat},${lng}););out body;`;
    const data = await overpassQuery(q);
    const results = (data.elements || []).filter((e: any) => e.type === 'node') as OverpassNode[];
    if (results.length > 0) return results;
  } catch { /* fall through */ }
  return [];
}

function getStationLineName(station: OverpassNode): string {
  return station.tags?.lines?.split(', ')[0] || station.tags?.line || '';
}

// ── OSRM walk/drive leg helper ───────────────────────────────────────────────

async function osrmWalkLeg(
  from: { lat: number; lng: number; label: string },
  to: { lat: number; lng: number; label: string },
): Promise<JourneyLeg> {
  void from;
  void to;
  return unsupportedTransitApi('OSRM');
}

function closestNode(nodes: OverpassNode[], lat: number, lng: number): OverpassNode | null {
  if (nodes.length === 0) return null;
  let best = nodes[0];
  let bestDist = haversineDistance(lat, lng, best.lat, best.lon);
  for (let i = 1; i < nodes.length; i++) {
    const d = haversineDistance(lat, lng, nodes[i].lat, nodes[i].lon);
    if (d < bestDist) { best = nodes[i]; bestDist = d; }
  }
  return best;
}

function nodeName(node: OverpassNode): string {
  return node.tags?.name || node.tags?.['name:ja'] || node.tags?.['name:en'] || `Station ${node.id}`;
}

function straightLineGeometry(from: [number, number], to: [number, number]): any {
  return { type: 'LineString', coordinates: [from, to] };
}

// Find intermediate hub stations along a path and split a single transit leg into segments
function splitTransitLeg(
  originStation: OverpassNode,
  destStation: OverpassNode,
  baseLineName: string,
): JourneyLeg[] {
  const totalDist = haversineDistance(originStation.lat, originStation.lon, destStation.lat, destStation.lon);
  if (totalDist < 100000) return []; // Don't split routes under 100km

  // Find hub stations between origin and dest
  const corridorWidth = totalDist * 0.3; // 30% of total distance as corridor width

  const candidates: Array<{ station: StationEntry; progress: number }> = [];
  for (const s of WORLD_STATIONS) {
    // Skip if same as origin or dest
    const distToOrigin = haversineDistance(s.lat, s.lng, originStation.lat, originStation.lon);
    const distToDest = haversineDistance(s.lat, s.lng, destStation.lat, destStation.lon);
    if (distToOrigin < 5000 || distToDest < 5000) continue;

    // Check if station is roughly between origin and dest
    // Project station onto the line origin→dest
    const dx = destStation.lon - originStation.lon;
    const dy = destStation.lat - originStation.lat;
    const t = ((s.lng - originStation.lon) * dx + (s.lat - originStation.lat) * dy) / (dx * dx + dy * dy);
    if (t < 0.1 || t > 0.9) continue;

    // Check perpendicular distance from the line
    const projLat = originStation.lat + t * dy;
    const projLng = originStation.lon + t * dx;
    const perpDist = haversineDistance(s.lat, s.lng, projLat, projLng);
    if (perpDist > corridorWidth) continue;

    candidates.push({ station: s, progress: t });
  }

  if (candidates.length === 0) return [];

  // Sort by progress and pick evenly spaced stops (max 3 intermediate)
  candidates.sort((a, b) => a.progress - b.progress);
  const selected: StationEntry[] = [];
  if (candidates.length <= 3) {
    selected.push(...candidates.map(c => c.station));
  } else {
    // Pick 2-3 evenly spaced
    const step = candidates.length / 3;
    for (let i = 0; i < 3; i++) {
      selected.push(candidates[Math.floor(i * step)].station);
    }
  }

  // Build chain: origin → hub1 → hub2 → ... → dest
  const chain: Array<{ lat: number; lon: number; name: string; lines: string }> = [
    { lat: originStation.lat, lon: originStation.lon, name: nodeName(originStation), lines: getStationLineName(originStation) },
    ...selected.map(s => ({ lat: s.lat, lon: s.lng, name: s.name, lines: s.lines.join(', ') })),
    { lat: destStation.lat, lon: destStation.lon, name: nodeName(destStation), lines: getStationLineName(destStation) },
  ];

  const legs: JourneyLeg[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const from = chain[i];
    const to = chain[i + 1];
    const dist = haversineDistance(from.lat, from.lon, to.lat, to.lon);
    const speed = dist > 200000 ? 250 : dist > 50000 ? 100 : 40;
    const dur = (dist / (speed * 1000)) * 3600;
    const line = from.lines?.split(', ')[0] || baseLineName;
    legs.push({
      mode: 'train',
      lineName: line || 'Rail',
      fromStop: from.name,
      toStop: to.name,
      fromCoords: [from.lon, from.lat],
      toCoords: [to.lon, to.lat],
      geometry: straightLineGeometry([from.lon, from.lat], [to.lon, to.lat]),
      distanceMeters: dist,
      durationSeconds: dur,
    });
  }

  return legs;
}

function assembleJourney(legs: JourneyLeg[], index: number): MultiModalJourney {
  const totalDistanceMeters = legs.reduce((s, l) => s + l.distanceMeters, 0);
  const totalDurationSeconds = legs.reduce((s, l) => s + l.durationSeconds, 0);
  return { legs, totalDistanceMeters, totalDurationSeconds, index };
}

// ── Public routing functions ─────────────────────────────────────────────────

export async function routeTransit(
  origin: { lat: number; lng: number; label: string },
  dest: { lat: number; lng: number; label: string },
): Promise<MultiModalJourney[]> {
  const [originStations, destStations] = await Promise.all([
    findNearbyStations(origin.lat, origin.lng),
    findNearbyStations(dest.lat, dest.lng),
  ]);

  if (originStations.length === 0 || destStations.length === 0) {
    throw new Error('No railway station found nearby / 付近に駅が見つかりませんでした');
  }

  const originStation = closestNode(originStations, origin.lat, origin.lng)!;
  const destStation = closestNode(destStations, dest.lat, dest.lng)!;

  const [walkLeg1, walkLeg2] = await Promise.all([
    osrmWalkLeg(origin, { lat: originStation.lat, lng: originStation.lon, label: nodeName(originStation) }),
    osrmWalkLeg({ lat: destStation.lat, lng: destStation.lon, label: nodeName(destStation) }, dest),
  ]);

  const lineName = getStationLineName(originStation);

  // Try to split long-distance transit into intermediate hub legs
  const splitLegs = splitTransitLeg(originStation, destStation, lineName || 'Rail');

  const transitLegs: JourneyLeg[] = splitLegs.length > 0
    ? splitLegs
    : [(() => {
        const transitDistM = haversineDistance(originStation.lat, originStation.lon, destStation.lat, destStation.lon);
        const speedKmh = transitDistM > 200000 ? 250 : transitDistM > 50000 ? 100 : 40;
        const transitDurS = (transitDistM / (speedKmh * 1000)) * 3600;
        return {
          mode: 'train' as const,
          lineName: lineName || 'Rail',
          fromStop: nodeName(originStation),
          toStop: nodeName(destStation),
          fromCoords: [originStation.lon, originStation.lat] as [number, number],
          toCoords: [destStation.lon, destStation.lat] as [number, number],
          geometry: straightLineGeometry(
            [originStation.lon, originStation.lat],
            [destStation.lon, destStation.lat],
          ),
          distanceMeters: transitDistM,
          durationSeconds: transitDurS,
        };
      })()];

  const legs: JourneyLeg[] = [];
  if (walkLeg1.distanceMeters > 30) legs.push(walkLeg1);
  legs.push(...transitLegs);
  if (walkLeg2.distanceMeters > 30) legs.push(walkLeg2);

  const journey = assembleJourney(legs, 0);
  const journeys: MultiModalJourney[] = [journey];

  // Alternative via different origin station
  if (originStations.length >= 2) {
    const alt = originStations.find((s) => s.id !== originStation.id);
    if (alt) {
      try {
        const altWalk1 = await osrmWalkLeg(origin, { lat: alt.lat, lng: alt.lon, label: nodeName(alt) });
        const altLine = getStationLineName(alt);
        const altSplitLegs = splitTransitLeg(alt, destStation, altLine || 'Rail');
        let altTransitLegs: JourneyLeg[];
        if (altSplitLegs.length > 0) {
          altTransitLegs = altSplitLegs;
        } else {
          const altDist = haversineDistance(alt.lat, alt.lon, destStation.lat, destStation.lon);
          const altSpeed = altDist > 200000 ? 250 : altDist > 50000 ? 100 : 40;
          altTransitLegs = [{
            mode: 'train',
            lineName: altLine || 'Rail',
            fromStop: nodeName(alt),
            toStop: nodeName(destStation),
            fromCoords: [alt.lon, alt.lat],
            toCoords: [destStation.lon, destStation.lat],
            geometry: straightLineGeometry([alt.lon, alt.lat], [destStation.lon, destStation.lat]),
            distanceMeters: altDist,
            durationSeconds: (altDist / (altSpeed * 1000)) * 3600,
          }];
        }
        const altLegs: JourneyLeg[] = [];
        if (altWalk1.distanceMeters > 30) altLegs.push(altWalk1);
        altLegs.push(...altTransitLegs);
        if (walkLeg2.distanceMeters > 30) altLegs.push(walkLeg2);
        journeys.push(assembleJourney(altLegs, 1));
      } catch { /* skip alt */ }
    }
  }

  return journeys;
}

export async function routeFerry(
  origin: { lat: number; lng: number; label: string },
  dest: { lat: number; lng: number; label: string },
): Promise<MultiModalJourney[]> {
  const [originTerminals, destTerminals] = await Promise.all([
    findNearbyFerryTerminals(origin.lat, origin.lng),
    findNearbyFerryTerminals(dest.lat, dest.lng),
  ]);

  if (originTerminals.length === 0 || destTerminals.length === 0) {
    throw new Error('No ferry terminal found nearby / 付近にフェリーターミナルが見つかりませんでした');
  }

  const originTerminal = closestNode(originTerminals, origin.lat, origin.lng)!;
  const destTerminal = closestNode(destTerminals, dest.lat, dest.lng)!;

  const [walkLeg1, walkLeg2] = await Promise.all([
    osrmWalkLeg(origin, { lat: originTerminal.lat, lng: originTerminal.lon, label: nodeName(originTerminal) }),
    osrmWalkLeg({ lat: destTerminal.lat, lng: destTerminal.lon, label: nodeName(destTerminal) }, dest),
  ]);

  const ferryDistM = haversineDistance(originTerminal.lat, originTerminal.lon, destTerminal.lat, destTerminal.lon);
  const ferryDurS = (ferryDistM / 28000) * 3600; // 28 km/h (15 knots)

  const ferryLeg: JourneyLeg = {
    mode: 'ferry',
    lineName: 'Ferry',
    fromStop: nodeName(originTerminal),
    toStop: nodeName(destTerminal),
    fromCoords: [originTerminal.lon, originTerminal.lat],
    toCoords: [destTerminal.lon, destTerminal.lat],
    geometry: straightLineGeometry(
      [originTerminal.lon, originTerminal.lat],
      [destTerminal.lon, destTerminal.lat],
    ),
    distanceMeters: ferryDistM,
    durationSeconds: ferryDurS,
  };

  const legs: JourneyLeg[] = [];
  if (walkLeg1.distanceMeters > 30) legs.push(walkLeg1);
  legs.push(ferryLeg);
  if (walkLeg2.distanceMeters > 30) legs.push(walkLeg2);

  return [assembleJourney(legs, 0)];
}

export async function routeFlight(
  origin: { lat: number; lng: number; label: string },
  dest: { lat: number; lng: number; label: string },
): Promise<MultiModalJourney[]> {
  let bestOriginAirport = WORLD_AIRPORTS[0];
  let bestOriginDist = haversineDistance(origin.lat, origin.lng, bestOriginAirport.lat, bestOriginAirport.lng);
  for (const ap of WORLD_AIRPORTS) {
    const d = haversineDistance(origin.lat, origin.lng, ap.lat, ap.lng);
    if (d < bestOriginDist) { bestOriginAirport = ap; bestOriginDist = d; }
  }

  let bestDestAirport = WORLD_AIRPORTS[0];
  let bestDestDist = haversineDistance(dest.lat, dest.lng, bestDestAirport.lat, bestDestAirport.lng);
  for (const ap of WORLD_AIRPORTS) {
    const d = haversineDistance(dest.lat, dest.lng, ap.lat, ap.lng);
    if (d < bestDestDist) { bestDestAirport = ap; bestDestDist = d; }
  }

  if (bestOriginAirport.iata === bestDestAirport.iata) {
    throw new Error('Origin and destination share the same nearest airport / 出発地と目的地の最寄り空港が同じです');
  }

  const [walkLeg1, walkLeg2] = await Promise.all([
    osrmWalkLeg(origin, { lat: bestOriginAirport.lat, lng: bestOriginAirport.lng, label: bestOriginAirport.name }),
    osrmWalkLeg({ lat: bestDestAirport.lat, lng: bestDestAirport.lng, label: bestDestAirport.name }, dest),
  ]);

  const flightDistM = haversineDistance(
    bestOriginAirport.lat, bestOriginAirport.lng,
    bestDestAirport.lat, bestDestAirport.lng,
  );
  const flightDurS = (flightDistM / 800000) * 3600 + 1800; // 800 km/h + 30min boarding

  const arc = generateGreatCircleArc(
    [bestOriginAirport.lng, bestOriginAirport.lat],
    [bestDestAirport.lng, bestDestAirport.lat],
  );

  const flightLeg: JourneyLeg = {
    mode: 'flight',
    lineName: `${bestOriginAirport.iata}\u2192${bestDestAirport.iata}`,
    fromStop: `${bestOriginAirport.name} (${bestOriginAirport.iata})`,
    toStop: `${bestDestAirport.name} (${bestDestAirport.iata})`,
    fromCoords: [bestOriginAirport.lng, bestOriginAirport.lat],
    toCoords: [bestDestAirport.lng, bestDestAirport.lat],
    geometry: arc,
    distanceMeters: flightDistM,
    durationSeconds: flightDurS,
  };

  const legs: JourneyLeg[] = [];
  if (walkLeg1.distanceMeters > 50) legs.push(walkLeg1);
  legs.push(flightLeg);
  if (walkLeg2.distanceMeters > 50) legs.push(walkLeg2);

  return [assembleJourney(legs, 0)];
}
