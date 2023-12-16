import { loadDocuments } from "@graphql-tools/load";
import { CodeFileLoader } from "@graphql-tools/code-file-loader";
import * as fs from "fs";
import {
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  OperationDefinitionNode,
  SelectionNode,
} from "graphql";

// NOTES [EP]:
// Generates all queries and fragments from one script and outputs a json. In our case, we output the json into wwwroot folder which is
// then parsed during backend startup and data is loaded in memory as singleton. Is later injected as a dependency in graphql processor which looks up required information.
// The other approaches don't generate properly along with queries and fragments. So need to use the tools and roll our own.

// Reference for tooling used here: https://the-guild.dev/graphql/tools/docs/documents-loading
// Another approach is this but internally graphql tools uses graphql tag pluck: https://the-guild.dev/graphql/tools/docs/graphql-tag-pluck

interface QueryItem {
  operationName: string;
  fileName: string;
  rawQuery: string;
  fragmentNames?: string[];
}

interface FragmentItem {
  name: string;
  fileName: string;
  rawQuery: string;
  fragmentNames?: string[];
}

const GENERATED_QUERIES_FOLDER_PATH = "GraphqlQueries/";
const GENERATED_QUERIES_FILE_NAME = "generatedQueries.json";
const GENERATED_FRAGMENTS_FILE_NAME = "generatedFragments.json";
const ALL_FILES_PATH_EXCLUDING_TESTS = "./app/**/!(*.test)*.{ts,tsx}";
// const ALL_FILES_PATH = './app/**/*.{ts,tsx}';
// leaving some testing paths to debug (helps to run faster)
// const SAMPLE_PATH = './SamplePath/queries.ts';

/** Add __typename field to all fields. This is done by apollo automatically so we need to do this here as well. This is set globally as an option to InMemoryCache.
 * Switching this behavior off results in issues as apollo does not convert the response from backend into the right type when resolving on client side.
 * Reference to the issue logged for this is here: https://github.com/apollographql/apollo-client/issues/11028
 */
const addTypeNameField = (query: string): string => {
  try {
    const firstIndex = query.indexOf("{");
    const lastIndex = query.lastIndexOf("}");
    const pre = query.substring(0, firstIndex + 1);
    const body = query.substring(firstIndex + 1, lastIndex);
    const post = query.substring(lastIndex);
    const typeNameAdded = body.replaceAll("}", "__typename }");
    const updatedQuery = pre + typeNameAdded + post;
    return updatedQuery;
  } catch (e) {
    console.log(
      "error occurred when trying to addTypeNameField for input: " + query
    );
    console.log(e);
  }
  return query;
};

/** Remove unnecessary line breaks. Makes sure we don't incorrectly collapse fields like field1\nfield2*/
const removeLineBreaks = (query: string): string => {
  try {
    query = query.replace(/(\r\n|\n|\r)/gm, " ");
  } catch (e) {
    console.log(
      "error occurred when trying to removeLineBreaks for input: " + query
    );
    console.log(e);
  }
  return query;
};

/** Remove all spaces greater than count 1*/
const removeUnnecessarySpaces = (query: string): string => {
  try {
    query = query.replace(/ +(?= )/g, "");
  } catch (e) {
    console.log(
      "error occurred when trying to removeUnnecessarySpaces for input: " +
        query
    );
    console.log(e);
  }
  return query;
};

/** Cleanup raw query to remove unnecessary spaces, line breaks and add __typename fields if omitted by developer. Apollo needs it.  */
const cleanupQueryContents = (query: string) => {
  try {
    query = removeLineBreaks(query);
    query = removeUnnecessarySpaces(query);
    query = addTypeNameField(query);
  } catch (e) {
    console.log("error occurred when cleaning up query: " + query);
    console.log(e);
  }
  return query;
};

const writeAndSaveFile = (fileName: string, contents: string) => {
  try {
    fs.writeFileSync(fileName, contents);
  } catch (e) {
    console.log(
      "error occurred when trying to writeAndSaveFile for: " + fileName
    );
    console.log(e);
  }
};

const generateJsonQueriesFile = (queries: QueryItem[]) => {
  try {
    const jsonString = JSON.stringify(queries, undefined, 2);
    writeAndSaveFile(
      GENERATED_QUERIES_FOLDER_PATH + GENERATED_QUERIES_FILE_NAME,
      jsonString
    );
  } catch (e) {
    console.log("error occurred when trying to generateJsonQueriesFile");
    console.log(e);
  }
};

const generateJsonFragmentsFile = (fragments: FragmentItem[]) => {
  try {
    const jsonString = JSON.stringify(fragments, undefined, 2);
    writeAndSaveFile(
      GENERATED_QUERIES_FOLDER_PATH + GENERATED_FRAGMENTS_FILE_NAME,
      jsonString
    );
  } catch (e) {
    console.log("error occurred when trying to generateJsonFragmentsFile");
    console.log(e);
  }
};

const generateDocuments = (logStatistics = true, logFull = false) => {
  try {
    const queries = new Map<string, QueryItem>();
    const duplicateQueries = new Map<string, QueryItem>();
    const fragments = new Map<string, FragmentItem>();
    const duplicateFragments = new Map<string, FragmentItem>();

    console.log("Scanning code base for all queries and fragments...");

    loadDocuments(ALL_FILES_PATH_EXCLUDING_TESTS, {
      loaders: [new CodeFileLoader()],
    })
      .then((sources) => {
        for (const source of sources) {
          if (source.document && source.location && source.rawSDL) {
            const fileName = source.location.substring(
              source.location.indexOf("app/")
            );
            const rawQuery = cleanupQueryContents(source.rawSDL);
            const fragmentDefinition = source.document.definitions.find(
              (x) => x.kind === "FragmentDefinition"
            );

            const asFragmentDefinitionNode =
              fragmentDefinition as FragmentDefinitionNode;

            if (asFragmentDefinitionNode) {
              const fragName = asFragmentDefinitionNode?.name?.value;
              if (!fragName) {
                console.log("unable to get fragment name");
                continue;
              }
              let dupFragIndex = 1;
              if (fragments.has(fragName)) {
                duplicateFragments.set(fragName + "_" + dupFragIndex, {
                  name: fragName + "_" + dupFragIndex,
                  fileName,
                  rawQuery,
                });
                dupFragIndex++;
              } else {
                fragments.set(fragName, { name: fragName, fileName, rawQuery });
              }

              continue;
            }

            const operationDefinition = source.document.definitions.find(
              (x) => x.kind === "OperationDefinition"
            );
            const asOperationDefinitionNode =
              operationDefinition as OperationDefinitionNode;
            const fragmentLinkNames: string[] = [];
            if (asOperationDefinitionNode) {
              const buildFragmentSpreads = (
                selectionNodes: SelectionNode[]
              ) => {
                const fragSections = selectionNodes.filter(
                  (x) => x.kind === "FragmentSpread"
                );
                const asFragmentSpreadNodes = fragSections.map(
                  (x) => x as FragmentSpreadNode
                );
                if (asFragmentSpreadNodes) {
                  fragmentLinkNames.push(
                    ...asFragmentSpreadNodes.map((x) => x?.name?.value)
                  );
                }

                const fieldSections = selectionNodes.filter(
                  (x) => x.kind === "Field"
                );
                if (fieldSections) {
                  for (const fieldSection of fieldSections) {
                    const asFieldNode = fieldSection as FieldNode;
                    if (
                      asFieldNode.selectionSet &&
                      asFieldNode.selectionSet.selections
                    ) {
                      // @ts-ignore
                      buildFragmentSpreads(asFieldNode.selectionSet.selections);
                    }
                  }
                }
              };

              if (
                asOperationDefinitionNode.selectionSet &&
                asOperationDefinitionNode.selectionSet.selections
              ) {
                buildFragmentSpreads(
                  // @ts-ignore
                  asOperationDefinitionNode.selectionSet.selections
                );
              }
            }

            const operationName = asOperationDefinitionNode?.name?.value;
            if (!operationName) {
              console.log("Cannot get operation name");
              continue;
            }

            let dupQueryIndex = 1;
            if (queries.has(operationName)) {
              duplicateQueries.set(operationName + "_" + dupQueryIndex, {
                operationName: operationName + "_" + dupQueryIndex,
                fileName,
                rawQuery,
                fragmentNames: fragmentLinkNames,
              });
              dupQueryIndex++;
            } else {
              queries.set(operationName, {
                operationName,
                fileName,
                rawQuery,
                fragmentNames: fragmentLinkNames,
              });
            }
          }
        }

        if (logStatistics) {
          console.log("Overall Statistics");
          console.log("==============");
          console.log("Operations: " + queries.size);
          console.log("Fragments: " + fragments.size);
          const duplicateQueriesCount = duplicateQueries.size;
          if (duplicateQueriesCount > 0) {
            console.log(
              ":\\ Alas, there are duplicate queries by operation name. Please fix before going forward."
            );
            console.log("Duplicate Queries: " + duplicateQueriesCount);
            const dupQueryNames = Array.from(duplicateQueries.keys());
            console.log("Duplicate Query names: " + dupQueryNames.join(","));
          } else {
            console.log("Awesome! No duplicate queries");
          }

          const duplicateFragmentsCount = duplicateFragments.size;
          if (duplicateFragmentsCount > 0) {
            console.log(
              ":\\ Alas, there are duplicate fragments by fragment name. Please fix before going forward."
            );
            console.log("Duplicate Fragments: " + duplicateFragmentsCount);
            const dupFragmentNames = Array.from(duplicateFragments.keys());
            console.log(
              "Duplicate Fragment names: " + dupFragmentNames.join(",")
            );
          } else {
            console.log("Awesome! No duplicate fragments");
          }
          console.log(
            "Please do check to see if queries are generated and DO NOT forget to commit them !"
          );
          console.log("==============");
        }

        const flatQueryCollection = Array.from(queries.values());
        const flatFragmentCollection = Array.from(fragments.values());
        if (logFull) {
          console.log("Logging All");
          console.log("==============");
          console.log("Queries");
          for (const item of flatQueryCollection) {
            console.log("==============");
            console.log("Operation Name: " + item.operationName);
            console.log("File Name: " + item.fileName);
            console.log("Raw Query: " + item.rawQuery);
            console.log("==============");
          }

          console.log("Fragments");
          for (const item of flatFragmentCollection) {
            console.log("==============");
            console.log("Fragment Name: " + item.name);
            console.log("File Name: " + item.fileName);
            console.log("Raw Query: " + item.rawQuery);
            console.log("==============");
          }
          console.log("==============");
          console.log("\n");
        }

        generateJsonQueriesFile(flatQueryCollection);
        generateJsonFragmentsFile(flatFragmentCollection);
      })
      .catch((e) => {
        console.log("Failed while processing queries/fragments: " + e);
      });
    return;
  } catch (err) {
    console.log("Generation Failed: " + err);
  }
};

generateDocuments();
