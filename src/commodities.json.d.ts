declare module "../assets/commodities.json" {
    interface CommodityRecord {
      location: string;
      date: string;
      commodity: string;
      type: string;
      dataset: string;
      value: number;
    }
  
    const value: CommodityRecord[];
    export default value;
  }