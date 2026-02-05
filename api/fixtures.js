// api/fixtures.js - ENHANCED VERSION
export default async function handler(req, res) {
  try {
    const API_KEY = process.env.API_SPORTS_KEY || "6d1dc2bda07f1d1768d9ad2d082f00d4";
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const league = req.query.league || "";

    console.log(`Fetching fixtures for ${date}...`);

    // 1. Fetch today's fixtures
    const fixturesUrl = `https://v3.football.api-sports.io/fixtures?date=${date}`;
    const fixturesResponse = await fetch(fixturesUrl, {
      headers: { "x-apisports-key": API_KEY }
    });
    
    const fixturesData = await fixturesResponse.json();
    
    if (!fixturesData.response || fixturesData.response.length === 0) {
      return res.status(200).json({ 
        fixtures: [],
        message: "No fixtures found for this date"
      });
    }

    // 2. Enhance each fixture with historical data
    const enhancedFixtures = await Promise.all(
      fixturesData.response.slice(0, 15).map(async (fixture) => { // Limit to 15 for performance
        const homeId = fixture.teams.home.id;
        const awayId = fixture.teams.away.id;
        
        try {
          // Fetch multiple data sources in parallel
          const [h2hData, homeFormData, awayFormData] = await Promise.all([
            fetchH2HData(homeId, awayId, API_KEY),
            fetchTeamForm(homeId, API_KEY),
            fetchTeamForm(awayId, API_KEY)
          ]);
          
          // Calculate statistics from REAL data
          const homeStats = calculateTeamStatsFromData(homeFormData, homeId);
          const awayStats = calculateTeamStatsFromData(awayFormData, awayId);
          
          // Analyze the match
          const analysis = analyzeMatchWithRealData(
            homeStats, 
            awayStats, 
            h2hData,
            fixture.league.id
          );
          
          return {
            fixture: {
              id: fixture.fixture.id,
              date: fixture.fixture.date,
              venue: fixture.fixture.venue?.name || "TBD",
              status: fixture.fixture.status
            },
            league: {
              id: fixture.league.id,
              name: fixture.league.name,
              country: fixture.league.country,
              logo: fixture.league.logo
            },
            teams: {
              home: {
                id: homeId,
                name: fixture.teams.home.name,
                logo: fixture.teams.home.logo
              },
              away: {
                id: awayId,
                name: fixture.teams.away.name,
                logo: fixture.teams.away.logo
              }
            },
            goals: fixture.goals,
            odds: fixture.odds?.bookmakers?.[0]?.bets || null,
            analysis: analysis,
            stats: {
              home: homeStats,
              away: awayStats
            },
            h2h: h2hData.slice(0, 5), // Last 5 H2H matches
            form: {
              home: extractFormFromMatches(homeFormData, homeId),
              away: extractFormFromMatches(awayFormData, awayId)
            }
          };
        } catch (error) {
          console.error(`Error processing fixture ${fixture.fixture.id}:`, error);
          // Return basic fixture without enhanced data
          return {
            fixture: fixture.fixture,
            league: fixture.league,
            teams: fixture.teams,
            goals: fixture.goals,
            analysis: { recommendation: "DATA UNAVAILABLE", confidence: 0, advice: "Historical data could not be loaded" }
          };
        }
      })
    );

    // Filter by league if specified
    const filteredFixtures = league 
      ? enhancedFixtures.filter(f => f.league.id.toString() === league)
      : enhancedFixtures;

    // Add cache headers
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    
    res.status(200).json({ 
      fixtures: filteredFixtures,
      count: filteredFixtures.length,
      date: date
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: "Failed to fetch data",
      details: error.message 
    });
  }
}

// Helper functions
async function fetchH2HData(homeId, awayId, apiKey) {
  try {
    const h2hUrl = `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`;
    const response = await fetch(h2hUrl, {
      headers: { "x-apisports-key": apiKey }
    });
    const data = await response.json();
    return data.response || [];
  } catch (error) {
    console.warn(`H2H fetch failed for ${homeId}-${awayId}:`, error.message);
    return [];
  }
}

async function fetchTeamForm(teamId, apiKey) {
  try {
    const formUrl = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=10&season=2024`;
    const response = await fetch(formUrl, {
      headers: { "x-apisports-key": apiKey }
    });
    const data = await response.json();
    return data.response || [];
  } catch (error) {
    console.warn(`Form fetch failed for team ${teamId}:`, error.message);
    return [];
  }
}

function calculateTeamStatsFromData(matches, teamId) {
  if (!matches || matches.length === 0) {
    return {
      goalsScored: "0.0",
      goalsConceded: "0.0",
      winRate: 0,
      cleanSheets: 0,
      bttsRate: 0,
      avgCorners: 0,
      avgCards: 0
    };
  }

  let goalsFor = 0, goalsAgainst = 0, wins = 0, draws = 0, losses = 0;
  let cleanSheets = 0, btts = 0, corners = 0, cards = 0;

  matches.forEach(match => {
    const isHome = match.teams.home.id === teamId;
    const gf = isHome ? match.goals.home : match.goals.away;
    const ga = isHome ? match.goals.away : match.goals.home;
    
    goalsFor += gf;
    goalsAgainst += ga;
    
    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
    
    if (ga === 0) cleanSheets++;
    if (gf > 0 && ga > 0) btts++;
    
    // Add other stats if available
    corners += (match.statistics?.corners || 0);
    cards += ((match.statistics?.yellow_cards || 0) + (match.statistics?.red_cards || 0));
  });

  const totalMatches = matches.length;

  return {
    goalsScored: (goalsFor / totalMatches).toFixed(1),
    goalsConceded: (goalsAgainst / totalMatches).toFixed(1),
    winRate: Math.round((wins / totalMatches) * 100),
    drawRate: Math.round((draws / totalMatches) * 100),
    lossRate: Math.round((losses / totalMatches) * 100),
    cleanSheets: Math.round((cleanSheets / totalMatches) * 100),
    bttsRate: Math.round((btts / totalMatches) * 100),
    avgCorners: Math.round(corners / totalMatches),
    avgCards: (cards / totalMatches).toFixed(1),
    formMatches: totalMatches
  };
}

function extractFormFromMatches(matches, teamId) {
  if (!matches || matches.length === 0) {
    return ['-', '-', '-', '-', '-'];
  }

  return matches.slice(0, 5).map(match => {
    const isHome = match.teams.home.id === teamId;
    const gf = isHome ? match.goals.home : match.goals.away;
    const ga = isHome ? match.goals.away : match.goals.home;
    
    if (gf > ga) return 'W';
    if (gf === ga) return 'D';
    return 'L';
  });
}

function analyzeMatchWithRealData(homeStats, awayStats, h2hMatches, leagueId) {
  // Base points from form
  const homeFormScore = parseInt(homeStats.winRate) * 0.3 + 
                       (100 - parseInt(homeStats.lossRate)) * 0.2;
  
  const awayFormScore = parseInt(awayStats.winRate) * 0.3 + 
                       (100 - parseInt(awayStats.lossRate)) * 0.2;

  // H2H analysis
  let h2hHomeWins = 0, h2hAwayWins = 0, h2hDraws = 0;
  if (h2hMatches.length > 0) {
    h2hMatches.forEach(match => {
      const homeWon = match.goals.home > match.goals.away;
      const awayWon = match.goals.away > match.goals.home;
      
      if (match.teams.home.id === homeStats.teamId) {
        if (homeWon) h2hHomeWins++;
        else if (awayWon) h2hAwayWins++;
        else h2hDraws++;
      } else {
        if (awayWon) h2hHomeWins++;
        else if (homeWon) h2hAwayWins++;
        else h2hDraws++;
      }
    });
  }

  // League-specific home advantage
  const homeAdvantage = {
    39: 0.15, // Premier League
    140: 0.12, // La Liga
    78: 0.18, // Bundesliga
    135: 0.10, // Serie A
    61: 0.08  // Ligue 1
  }[leagueId] || 0.12;

  // Calculate probabilities
  const homeStrength = homeFormScore * 0.5 + 
                      (h2hHomeWins / Math.max(h2hMatches.length, 1)) * 100 * 0.3 + 
                      homeAdvantage * 100 * 0.2;

  const awayStrength = awayFormScore * 0.5 + 
                      (h2hAwayWins / Math.max(h2hMatches.length, 1)) * 100 * 0.3;

  const totalStrength = homeStrength + awayStrength;
  const homeWinProb = totalStrength > 0 ? (homeStrength / totalStrength) * 100 : 50;
  const awayWinProb = totalStrength > 0 ? (awayStrength / totalStrength) * 100 : 30;
  const drawProb = 100 - homeWinProb - awayWinProb;

  // Determine recommendation
  let recommendation, confidence, advice = [];
  
  if (homeWinProb > awayWinProb + 15 && homeWinProb > 45) {
    recommendation = "HOME WIN";
    confidence = Math.min(95, homeWinProb);
    advice.push("Strong home advantage and positive H2H record.");
  } else if (awayWinProb > homeWinProb + 15 && awayWinProb > 45) {
    recommendation = "AWAY WIN";
    confidence = Math.min(95, awayWinProb);
    advice.push("Away team in superior form.");
  } else if (drawProb > 35 && Math.abs(homeWinProb - awayWinProb) < 10) {
    recommendation = "DRAW";
    confidence = Math.min(90, drawProb);
    advice.push("Evenly matched teams with similar form.");
  } else {
    recommendation = homeWinProb > awayWinProb ? "HOME WIN" : "AWAY WIN";
    confidence = Math.max(homeWinProb, awayWinProb);
    advice.push("Slight edge to this team based on recent form.");
  }

  // Add specific insights
  if (parseFloat(homeStats.goalsScored) > 2.0) {
    advice.push("Home team scoring heavily recently.");
  }
  if (parseFloat(awayStats.goalsConceded) > 1.5) {
    advice.push("Away team struggling defensively.");
  }
  if (h2hHomeWins > h2hAwayWins * 2) {
    advice.push("Strong historical advantage for home team.");
  }

  return {
    recommendation,
    confidence: Math.round(confidence),
    advice: advice.join(' '),
    probabilities: {
      home: Math.round(homeWinProb),
      draw: Math.round(drawProb),
      away: Math.round(awayWinProb)
    }
  };
}
