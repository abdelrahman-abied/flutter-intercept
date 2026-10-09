import 'package:dart_cli/fetch.dart';

// Synchronous main with args: the request completes after main returns (zone must carry over).
void main(List<String> args) {
  fetchAndPrint(args[0], 'bin/main');
}
