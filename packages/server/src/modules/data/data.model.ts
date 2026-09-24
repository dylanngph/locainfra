import {
	DataObjects,
	DataQueryRequest,
	DataQueryResult,
} from "@locastack/core";

/** `POST /api/projects/:project/services/:name/data/query` body. */
export const DataQueryBody = DataQueryRequest;
/** `POST …/data/query` body. */
export type DataQueryBody = typeof DataQueryBody.static;

/** Reference models of the Data tab controller, registered under `Data.`. */
export const DataModel = {
	objects: DataObjects,
	queryBody: DataQueryBody,
	result: DataQueryResult,
};
