import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs/promises";
import path from "path";
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
//RUN WITH "npm run build"
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";
// Create server instance
const server = new McpServer({
    name: "weather",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    },
});
// Helper function for making NWS API requests
async function makeNWSRequest(url) {
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: "application/geo+json",
    };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return (await response.json());
    }
    catch (error) {
        console.error("Error making NWS request:", error);
        return null;
    }
}
// Format alert data
function formatAlert(feature) {
    const props = feature.properties;
    return [
        `Event: ${props.event || "Unknown"}`,
        `Area: ${props.areaDesc || "Unknown"}`,
        `Severity: ${props.severity || "Unknown"}`,
        `Status: ${props.status || "Unknown"}`,
        `Headline: ${props.headline || "No headline"}`,
        "---",
    ].join("\n");
}
// Register weather tools
server.tool("get-alerts", "Get weather alerts for a state", {
    state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
    limit: z.number().int().positive().optional().describe("Optional limit on number of alerts to return"),
}, async ({ state, limit }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest(alertsUrl);
    if (!alertsData) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to retrieve alerts data",
                },
            ],
        };
    }
    const features = alertsData.features || [];
    if (features.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No active alerts for ${stateCode}`,
                },
            ],
        };
    }
    const formattedAlerts = features.map(formatAlert);
    // Apply limit if provided
    const limitedAlerts = limit !== undefined ? formattedAlerts.slice(0, limit) : formattedAlerts;
    const alertsText = `Active alerts for ${stateCode}:\n\n${limitedAlerts.join("\n")}`;
    return {
        content: [
            {
                type: "text",
                text: alertsText,
            },
        ],
    };
});
server.tool("get-forecast", "Get weather forecast for a location", {
    latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
    longitude: z.number().min(-180).max(180).describe("Longitude of the location"),
}, async ({ latitude, longitude }) => {
    // Get grid point data
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest(pointsUrl);
    if (!pointsData) {
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
                },
            ],
        };
    }
    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to get forecast URL from grid point data",
                },
            ],
        };
    }
    // Get forecast data
    const forecastData = await makeNWSRequest(forecastUrl);
    if (!forecastData) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to retrieve forecast data",
                },
            ],
        };
    }
    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: "No forecast periods available",
                },
            ],
        };
    }
    // Format forecast periods
    const formattedForecast = periods.map((period) => [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
    ].join("\n"));
    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;
    return {
        content: [
            {
                type: "text",
                text: forecastText,
            },
        ],
    };
});
server.tool("process-commodity-data", "Processes commodity data from a JSON file and returns a summary, optionally filtered by country.", {
    // filePath: z.string().describe("Path to the JSON file containing commodity data"),
    country: z.string().optional().describe("Optional: Filter data by a specific country name (e.g., 'India', 'Vietnam')"),
}, async ({ country }) => {
    const filePath = path.resolve(__dirname, "../assets/commodities.json");
    let fileContent;
    try {
        fileContent = await fs.readFile(filePath, "utf-8");
    }
    catch (error) {
        console.error(`Error reading commodity data file ${filePath}:`, error);
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to read the commodity data file from the server's configuration. Please check the server logs for details.`,
                },
            ],
        };
    }
    let commodityEntries;
    try {
        commodityEntries = JSON.parse(fileContent);
        if (!Array.isArray(commodityEntries) || commodityEntries.some(item => typeof item.id !== 'string' ||
            typeof item.country !== 'string' ||
            typeof item.commodity !== 'string' ||
            typeof item.value !== 'number' ||
            typeof item.unit !== 'string')) {
            throw new Error("Invalid JSON structure: Expected an array of commodity objects with 'id', 'country', 'commodity', 'value', 'unit'.");
        }
    }
    catch (error) {
        console.error(`Error parsing commodity data JSON from ${filePath}:`, error);
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to parse JSON from ${filePath}. Please ensure the file contains valid JSON and matches the expected commodity data format.`,
                },
            ],
        };
    }
    let filteredEntries = commodityEntries;
    if (country) {
        // Filter by country (case-insensitive for robustness)
        const targetCountry = country.toLowerCase();
        filteredEntries = commodityEntries.filter(item => item.country.toLowerCase() === targetCountry);
    }
    if (filteredEntries.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No commodity data found for ${country ? country : 'the specified criteria'} in the provided JSON file.`,
                },
            ],
        };
    }
    const summary = [`--- Commodity Data Summary for ${country ? country : 'All Countries'} ---`];
    let totalValueUSD = 0;
    filteredEntries.forEach(item => {
        summary.push(`ID: ${item.id}`);
        summary.push(`  Country: ${item.country}`);
        summary.push(`  Commodity: ${item.commodity}`);
        summary.push(`  Value: ${item.value} ${item.unit}`);
        summary.push("---");
        if (item.unit === "USD") {
            totalValueUSD += item.value;
        }
    });
    summary.push(`Total Value (USD, where applicable): ${totalValueUSD.toFixed(2)} USD`);
    return {
        content: [
            {
                type: "text",
                text: summary.join("\n"),
            },
        ],
    };
});
server.tool("get-player-stats", "Get player stats data from the CSV file with optional filtering, sorting, and limiting", {
    playerName: z.string().optional().describe("Optional player name to filter by"),
    team: z.string().optional().describe("Optional team name to filter by"),
    limit: z.number().int().positive().optional().describe("Optional limit on number of records to return"),
    sortBy: z.string().optional().describe("Optional field name to sort by"),
    sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort order: asc or desc (default desc)"),
}, async ({ playerName, team, limit, sortBy, sortOrder }) => {
    const filePath = path.resolve(__dirname, "../assets/player_stats.csv");
    let fileContent;
    // Basic CSV parser that handles quoted fields and commas inside quotes
    function parseCSVLine(line) {
        const result = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"'; // Escaped quote
                    i++;
                }
                else {
                    inQuotes = !inQuotes;
                }
            }
            else if (char === ',' && !inQuotes) {
                result.push(current);
                current = "";
            }
            else {
                current += char;
            }
        }
        result.push(current);
        return result;
    }
    try {
        fileContent = await fs.readFile(filePath, "utf-8");
    }
    catch (error) {
        console.error(`Error reading player stats file ${filePath}:`, error);
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to read the player stats file. Please check the server logs for details.`,
                },
            ],
        };
    }
    // Parse CSV content
    const lines = fileContent.trim().split("\n");
    if (lines.length < 2) {
        return {
            content: [
                {
                    type: "text",
                    text: "Player stats CSV file is empty or missing data.",
                },
            ],
        };
    }
    const headers = parseCSVLine(lines[0]);
    let data = lines.slice(1).map(line => {
        const values = parseCSVLine(line);
        const obj = {};
        headers.forEach((header, index) => {
            obj[header.trim()] = values[index]?.trim() ?? "";
        });
        return obj;
    });
    // Filter by playerName if provided (case-insensitive)
    if (playerName) {
        const lowerName = playerName.toLowerCase();
        data = data.filter(item => {
            const nameValue = item["playerName"] || item["PlayerName"] || item["name"] || item["Name"] || "";
            return nameValue.toLowerCase().includes(lowerName);
        });
    }
    // Filter by team if provided (case-insensitive)
    if (team) {
        const lowerTeam = team.toLowerCase();
        data = data.filter(item => {
            const teamValue = item["team"] || item["Team"] || "";
            return teamValue.toLowerCase().includes(lowerTeam);
        });
    }
    // Sort by sortBy field if provided
    if (sortBy) {
        const order = sortOrder === "asc" ? 1 : -1;
        // Normalize sortBy to lower case for matching keys
        const sortKey = sortBy.trim().toLowerCase();
        data.sort((a, b) => {
            // Find matching keys in objects ignoring case
            const aKey = Object.keys(a).find(k => k.toLowerCase() === sortKey) ?? "";
            const bKey = Object.keys(b).find(k => k.toLowerCase() === sortKey) ?? "";
            const aVal = a[aKey] ?? "";
            const bVal = b[bKey] ?? "";
            // Try to compare as numbers if possible
            const aNum = parseFloat(aVal);
            const bNum = parseFloat(bVal);
            if (!isNaN(aNum) && !isNaN(bNum)) {
                return (aNum - bNum) * order;
            }
            // Otherwise compare as strings
            return aVal.localeCompare(bVal) * order;
        });
    }
    // Limit the number of records if limit is provided, max 10
    if (limit !== undefined) {
        const maxLimit = 10;
        data = data.slice(0, Math.min(limit, maxLimit));
    }
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(data, null, 2),
            },
        ],
    };
});
server.tool("get-player-stats-headers", "Get the list of headers (column names) from the player stats CSV file", {}, async () => {
    const filePath = path.resolve(__dirname, "../assets/player_stats.csv");
    try {
        const fileContent = await fs.readFile(filePath, "utf-8");
        const lines = fileContent.trim().split("\n");
        if (lines.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Player stats CSV file is empty.",
                    },
                ],
            };
        }
        const headers = lines[0].split(",").map(h => h.trim());
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(headers, null, 2),
                },
            ],
        };
    }
    catch (error) {
        console.error(`Error reading player stats file ${filePath}:`, error);
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to read the player stats file. Please check the server logs for details.",
                },
            ],
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Weather MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
