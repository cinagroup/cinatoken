/// <reference path="./complete-text-response-holder-v394-env.d.ts" />
import { createCompleteTextHolderWorkerV390,
	type CompleteTextHolderWorkerOptionsV390 } from './complete-text-holder-worker-v390';
import { createResponseObservedPrivateCompleteTextHolderV392 } from '../services/private-complete-text-response-holder-v392';
import { appendPostgresCompleteTextResponseObservationV392 } from '../services/postgres-complete-text-response-observation-v392';

/** A separate reviewed entry: complete response evidence requires the v392 SQL contract. */
export function createCompleteTextResponseHolderWorkerV394(options: CompleteTextHolderWorkerOptionsV390 = {}) {
	return createCompleteTextHolderWorkerV390(options, {
		createHolder(ports, database) {
			return createResponseObservedPrivateCompleteTextHolderV392({
				...ports,
				appendResponseObservation(input) {
					return database.own(() => appendPostgresCompleteTextResponseObservationV392({
						holderConnectionString: database.connectionString, ...input,
					}, database.createSql));
				},
			});
		},
	});
}

export default createCompleteTextResponseHolderWorkerV394() satisfies ExportedHandler<CompleteTextResponseHolderV394Env>;
